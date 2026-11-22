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
