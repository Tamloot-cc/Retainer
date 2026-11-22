-- Standalone apps (docs/specs/extensions.md §8). A standalone app's own
-- credential may write its installation's generated secrets, and nothing
-- else. The broker admits it in the same transaction as the write: the
-- installation is active on the release the API checked, the workspace is
-- not being deleted, and the credential is live for the current grant.
CREATE FUNCTION public.retainer_admit_secret_installation(p_registration uuid,p_installation uuid,p_grant_generation integer,p_credential uuid,p_kind text,p_release text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  credential_client text;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  IF NOT EXISTS(SELECT 1 FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.state='active' AND i.grant_generation=p_grant_generation AND i.release_digest=p_release
      AND w.deletion_scheduled_at IS NULL) THEN RETURN false; END IF;
  SELECT c.client_id INTO credential_client FROM public.extension_credentials c
    WHERE c.workspace_id=tenant AND c.id=p_credential AND c.installation_id=p_installation AND c.kind=p_kind
      AND c.generation=p_grant_generation AND c.revoked_at IS NULL AND NOT c.pending FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_kind='oauth' THEN
    -- Shared with the client, so disabling it waits for this write.
    RETURN public.retainer_extension_oauth_client_active(credential_client);
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_admit_secret_installation(uuid,uuid,integer,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_admit_secret_installation(uuid,uuid,integer,uuid,text,text) TO retainer_secret_broker;
--> statement-breakpoint
-- A standalone app's sidebar link opens a path on the app's origin: the one
-- origin its pinned OAuth client registered redirects on. Null when the
-- client is unknown, disabled or has redirects on more than one origin. The
-- API role cannot read OAuth clients, so this returns the origin only.
CREATE FUNCTION public.retainer_extension_oauth_client_origin(client text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN count(DISTINCT x.origin)=1 THEN min(x.origin) END FROM (
    SELECT substring(u.uri FROM '^(https?://[^/?#]+)') AS origin
    FROM public.oauth_clients c CROSS JOIN LATERAL unnest(c.redirect_uris) AS u(uri)
    WHERE c.client_id=client AND c.disabled IS NOT TRUE) x
  HAVING bool_and(x.origin IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_oauth_client_origin(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_oauth_client_origin(text) TO retainer_app;
--> statement-breakpoint
-- A sidebar link names its installation, so signing in to the app needs no
-- workspace picker. The control role finds the installation's workspace
-- here, then checks membership and reads the installation as the app role.
CREATE FUNCTION public.retainer_extension_installation_workspace(installation uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT i.workspace_id FROM public.extension_installations i WHERE i.id=installation
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_installation_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_installation_workspace(uuid) TO retainer_control;
--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "run_requires_credential" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Readiness, claim and broker admission use the same current-grant predicate.
-- The claim and broker hold the registration lock that serializes revocation.
-- Checking an OAuth client also holds a shared lock on the client row.
CREATE FUNCTION public.retainer_extension_credential_live(p_workspace uuid,p_installation uuid,p_grant_generation integer)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.extension_credentials c
    WHERE c.workspace_id=p_workspace AND c.installation_id=p_installation
      AND c.generation=p_grant_generation AND c.revoked_at IS NULL AND NOT c.pending
      AND (c.kind='key' OR (c.kind='oauth' AND public.retainer_extension_oauth_client_active(c.client_id)))
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_credential_live(uuid,uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_credential_live(uuid,uuid,integer) TO retainer_app;
--> statement-breakpoint
-- The claim records whether the pinned tool release is standalone, since
-- the broker cannot consult the runtime catalog. Keep the existing lock
-- order (workspace, registration, job) and admit the secret in that transaction.
CREATE OR REPLACE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_function uuid,p_name text,p_writing boolean,p_connection uuid DEFAULT NULL,p_connection_generation integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  current_state text; cleanup_live boolean; deleting boolean; job_trigger text; job_input jsonb; job_live boolean;
  connection_state text; connection_cleanup_live boolean; grant_generation integer; requires_credential boolean;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  SELECT i.state,i.cleanup_deadline>clock_timestamp(),w.deletion_scheduled_at IS NOT NULL,i.grant_generation
    INTO current_state,cleanup_live,deleting,grant_generation
    FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.generation=p_generation;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind,j.input,j.expires_at>clock_timestamp(),j.run_requires_credential
    INTO job_trigger,job_input,job_live,requires_credential FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.connection_id IS NOT DISTINCT FROM p_connection AND j.connection_generation IS NOT DISTINCT FROM p_connection_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp()
      AND j.function_id=p_function AND p_name=ANY(j.run_secrets) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF job_trigger='tool' AND requires_credential
    AND NOT public.retainer_extension_credential_live(tenant,p_installation,grant_generation) THEN RETURN false; END IF;
  IF job_trigger='configure' THEN
    RETURN NOT p_writing AND p_connection IS NULL AND NOT deleting AND current_state IN ('configuring','active')
      AND EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant AND i.id=p_installation
        AND (i.release_digest=p_release OR EXISTS(SELECT 1 FROM public.extension_access_approvals a
          WHERE a.workspace_id=tenant AND a.installation_id=p_installation AND a.release_digest=p_release
          AND a.generation=i.generation AND a.settings_revision=i.settings_revision)));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant AND i.id=p_installation AND i.release_digest=p_release) THEN RETURN false; END IF;
  IF p_connection IS NOT NULL THEN
    SELECT c.state,c.disconnected_at+interval '24 hours'>clock_timestamp() INTO connection_state,connection_cleanup_live
      FROM public.extension_connections c
      WHERE c.workspace_id=tenant AND c.installation_id=p_installation AND c.id=p_connection AND c.generation=p_connection_generation;
    IF NOT FOUND THEN RETURN false; END IF;
    IF job_trigger='disconnect' THEN
      IF p_writing THEN RETURN false; END IF;
      IF public.retainer_partial_release_job(job_trigger,job_input) THEN
        RETURN NOT deleting AND current_state='active' AND job_live IS TRUE
          AND connection_state IN ('setup_failed','needs_reconnect');
      END IF;
      RETURN connection_state='disconnected' AND connection_cleanup_live IS TRUE
        AND current_state<>'uninstalled' AND (current_state<>'uninstalling' OR cleanup_live IS TRUE);
    END IF;
    IF deleting OR current_state<>'active' THEN RETURN false; END IF;
    RETURN (job_trigger='connect' AND connection_state='connecting')
      OR (job_trigger NOT IN ('install','uninstall','connect','disconnect') AND connection_state='active');
  END IF;
  RETURN (NOT deleting AND job_trigger NOT IN ('install','uninstall','connect','disconnect') AND current_state='active')
    OR (NOT deleting AND job_trigger='install' AND current_state IN ('installing','upgrading'))
    OR (NOT p_writing AND job_trigger='uninstall' AND current_state='uninstalling' AND cleanup_live IS TRUE);
END $$;
