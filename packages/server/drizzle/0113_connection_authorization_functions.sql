-- Connect with Tamloot (docs/specs/extensions-tamloot-connect.md §4.3, §4.7).
-- OAuth handshakes, disconnect hooks that read the secrets they declare, and
-- partial release jobs: a `disconnect` job with input {"keep":"current"},
-- queued when an OAuth connection's setup fails or it needs reconnecting.
GRANT SELECT,INSERT,UPDATE,DELETE ON public.extension_authorizations TO retainer_app;
--> statement-breakpoint
-- The one predicate that tells a partial release job from disconnect cleanup.
CREATE FUNCTION public.retainer_partial_release_job(trigger_kind text,input jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(trigger_kind='disconnect' AND input->>'keep'='current',false)
$$;
--> statement-breakpoint
-- Whether a partial job holds a release change: before its deadline whatever its
-- attempt's state; after it only while an attempt holds a live lease.
CREATE FUNCTION public.retainer_partial_release_blocking(j public.extension_jobs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT public.retainer_partial_release_job(j.trigger_kind,j.input)
    AND j.status IN ('queued','running')
    AND (clock_timestamp()<j.expires_at OR (j.status='running' AND clock_timestamp()<j.lease_until))
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_partial_release_job(text,jsonb),public.retainer_partial_release_blocking(public.extension_jobs) TO retainer_app,retainer_executor;
--> statement-breakpoint
-- Secrets the reviewed disconnect hook declares stay readable by it for 24
-- hours after the disconnect; every other secret is retired at once.
CREATE OR REPLACE FUNCTION public.retainer_retire_member_secrets(p_installation uuid,p_connection uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  connection public.extension_connections;
BEGIN
  SELECT * INTO connection FROM public.extension_connections c WHERE c.workspace_id=tenant AND c.installation_id=p_installation
    AND c.id=p_connection AND c.state='disconnected';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.extension_secrets SET delete_after=CASE WHEN name=ANY(connection.disconnect_secrets)
      THEN connection.disconnected_at+interval '24 hours' ELSE clock_timestamp() END
    WHERE workspace_id=tenant AND installation_id=p_installation AND connection_id=p_connection;
  DELETE FROM public.extension_pending_secrets WHERE workspace_id=tenant AND draft_installation_id=p_installation AND connection_id=p_connection;
END $$;
--> statement-breakpoint
-- Ends the retained secrets once the cleanup of a disconnected connection reaches
-- a final state. Never used for a partial release job, which retires nothing.
CREATE FUNCTION public.retainer_finish_member_cleanup(p_installation uuid,p_connection uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.extension_connections c WHERE c.workspace_id=tenant AND c.installation_id=p_installation
    AND c.id=p_connection AND c.state='disconnected') THEN RETURN; END IF;
  UPDATE public.extension_secrets SET delete_after=clock_timestamp()
    WHERE workspace_id=tenant AND installation_id=p_installation AND connection_id=p_connection
      AND (delete_after IS NULL OR delete_after>clock_timestamp());
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_finish_member_cleanup(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_finish_member_cleanup(uuid,uuid) TO retainer_app;
--> statement-breakpoint
-- Never shortens or extends a window a member disconnect already set.
CREATE OR REPLACE FUNCTION public.retainer_retire_extension_secrets(installation uuid)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    UPDATE public.extension_secrets s SET delete_after=clock_timestamp()+interval '24 hours'
      WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND s.installation_id=installation
        AND (s.connection_id IS NULL OR s.delete_after IS NULL)
        AND EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=s.workspace_id AND i.id=installation AND i.state IN ('uninstalled','uninstalling'))
  $$;
--> statement-breakpoint
-- A cleanup hook may read, never write, the secrets its function declares: the
-- full hook while its connection is disconnected and inside its 24 hours, a
-- partial release job while its connection is setup_failed or needs_reconnect
-- at the job's generation, before the job's deadline, on an active installation.
CREATE OR REPLACE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_function uuid,p_name text,p_writing boolean,p_connection uuid DEFAULT NULL,p_connection_generation integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  current_state text; cleanup_live boolean; deleting boolean; job_trigger text; job_input jsonb; job_live boolean;
  connection_state text; connection_cleanup_live boolean;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  SELECT i.state,i.cleanup_deadline>clock_timestamp(),w.deletion_scheduled_at IS NOT NULL INTO current_state,cleanup_live,deleting
    FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.generation=p_generation;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind,j.input,j.expires_at>clock_timestamp() INTO job_trigger,job_input,job_live FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.connection_id IS NOT DISTINCT FROM p_connection AND j.connection_generation IS NOT DISTINCT FROM p_connection_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp()
      AND j.function_id=p_function AND p_name=ANY(j.run_secrets) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
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
--> statement-breakpoint
-- A partial release job is claimed while its connection stays failed at the job's
-- generation, before its deadline, and while no handshake of the connection is open.
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
RETURNS TABLE(workspace_id uuid,job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH candidates AS (
    SELECT DISTINCT ON(j.workspace_id,j.installation_id,j.connection_id)
      j.workspace_id,j.id,j.available_at,i.last_claimed_at as installation_claimed,c.last_claimed_at as connection_claimed
    FROM public.extension_jobs j
    JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
    JOIN public.workspaces w ON w.id=j.workspace_id AND (w.deletion_scheduled_at IS NULL OR j.trigger_kind IN ('uninstall','disconnect'))
    LEFT JOIN public.extension_connections c ON c.id=j.connection_id AND c.installation_id=j.installation_id AND c.workspace_id=j.workspace_id
    WHERE (i.registration_id,j.release_digest) IN (SELECT * FROM unnest($2,$3))
      AND j.generation=i.generation AND (j.release_digest=i.release_digest OR
        (j.trigger_kind='configure' AND i.state='active' AND EXISTS(SELECT 1 FROM public.extension_access_approvals a
          WHERE a.workspace_id=j.workspace_id AND a.installation_id=i.id AND a.release_digest=j.release_digest
          AND a.generation=i.generation AND a.settings_revision=i.settings_revision)))
      AND (
        (j.connection_id IS NULL AND (
          (i.state='configuring' AND j.trigger_kind='configure')
          OR (i.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')))
        OR (j.connection_id IS NOT NULL AND j.connection_generation=c.generation AND (
          (i.state='active' AND c.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state='active' AND c.state='connecting' AND j.trigger_kind='connect')
          OR (c.state='disconnected' AND c.disconnected_at+interval '24 hours'>now() AND j.trigger_kind='disconnect'
            AND NOT public.retainer_partial_release_job(j.trigger_kind,j.input))
          OR (i.state='active' AND w.deletion_scheduled_at IS NULL AND c.state IN ('setup_failed','needs_reconnect')
            AND public.retainer_partial_release_job(j.trigger_kind,j.input) AND j.expires_at>now()
            AND NOT EXISTS(SELECT 1 FROM public.extension_authorizations a WHERE a.workspace_id=j.workspace_id
              AND a.installation_id=j.installation_id AND a.connection_id=j.connection_id
              AND a.consumed_at IS NULL AND a.expires_at>now()))))
      )
      AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
        AND r.installation_id=j.installation_id AND r.connection_id IS NOT DISTINCT FROM j.connection_id
        AND r.status='running' AND r.lease_until>now() AND r.id<>j.id)
    ORDER BY j.workspace_id,j.installation_id,j.connection_id,
      CASE WHEN j.status='running' THEN 0 ELSE 1 END,j.available_at,j.id
  ) SELECT c.workspace_id,c.id FROM candidates c
    ORDER BY c.installation_claimed NULLS FIRST,c.connection_claimed NULLS FIRST,c.available_at,c.id
    LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
-- Maintenance also visits an installation, in any state, holding a partial
-- release job past its deadline that no live attempt holds: the sweep fails it.
CREATE OR REPLACE FUNCTION public.retainer_extension_maintenance_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE ((w.deletion_scheduled_at IS NULL OR i.state='uninstalling') AND (
      (i.state='configuring' AND i.created_at<=now()-interval '14 days')
      OR (i.state='uninstalling' AND i.cleanup_deadline<=now())
      OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j
          WHERE j.workspace_id=i.workspace_id AND j.installation_id=i.id AND j.generation=i.generation AND j.trigger_kind='uninstall'))
      OR (i.state='active' AND (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($2,$3))
        AND (NOT EXISTS(SELECT 1 FROM public.extension_schedules s
        WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id)
        OR EXISTS(SELECT 1 FROM public.extension_schedules s WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id AND s.next_due_at<=now())))))
      OR EXISTS(SELECT 1 FROM public.extension_jobs j WHERE j.workspace_id=i.workspace_id AND j.installation_id=i.id
        AND public.retainer_partial_release_job(j.trigger_kind,j.input) AND j.expires_at<=now()
        AND (j.status='queued' OR (j.status='running' AND j.lease_until<=now())))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
-- Auto-upgrade skips an installation with disconnect cleanup open or a blocking
-- partial release job (cleanupPending's rule, extensions/service.ts).
CREATE OR REPLACE FUNCTION public.retainer_extension_upgrades_due(batch_limit integer,target_registrations uuid[],target_digests text[])
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN unnest($2,$3) AS t(registration_id,release_digest) ON t.registration_id=i.registration_id
    JOIN public.workspaces w ON w.id=i.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE i.state='active' AND i.release_digest<>t.release_digest
      AND i.upgrade_held_digest IS DISTINCT FROM t.release_digest
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j WHERE j.workspace_id=i.workspace_id
        AND j.installation_id=i.id AND j.trigger_kind='disconnect' AND j.status IN ('queued','running')
        AND NOT public.retainer_partial_release_job(j.trigger_kind,j.input))
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j WHERE j.workspace_id=i.workspace_id
        AND j.installation_id=i.id AND public.retainer_partial_release_blocking(j))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
