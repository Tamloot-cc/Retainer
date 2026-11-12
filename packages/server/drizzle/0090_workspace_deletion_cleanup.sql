-- Workspace deletion uninstalls extensions (extensions spec 7, review R7). While
-- a workspace is being deleted only its extension cleanup runs: cleanup jobs
-- are discovered, queued, reconciled, reaped at their deadline and admitted to
-- the provider connection; every other kind of work stays excluded.
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer,candidate_runtime text)
  RETURNS TABLE(workspace_id uuid, job_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    WITH candidates AS (
      SELECT DISTINCT ON(j.workspace_id,j.installation_id) j.workspace_id,j.id,j.available_at
      FROM public.extension_jobs j
      JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
      JOIN public.workspaces w ON w.id=j.workspace_id AND (w.deletion_scheduled_at IS NULL OR j.trigger_kind='uninstall')
      WHERE NOT EXISTS(SELECT 1 FROM public.extension_runtime_unavailable u
      WHERE u.workspace_id=i.workspace_id AND u.installation_id=i.id AND u.runtime_identity=$2
        AND u.generation=i.generation AND u.release_digest=i.release_digest) AND ((i.state='active' AND j.trigger_kind NOT IN ('install','uninstall'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')) AND j.generation=i.generation AND j.release_digest=i.release_digest
        AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
        AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
          AND r.installation_id=j.installation_id AND r.status='running' AND r.id<>j.id)
      ORDER BY j.workspace_id,j.installation_id,j.available_at,j.id
    ) SELECT c.workspace_id,c.id FROM candidates c ORDER BY c.available_at,c.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
-- Adds uninstalling installations without a cleanup job at their generation:
-- a deletion made where the release could not be resolved leaves the worker
-- to queue it (ExtensionQueue.startCleanup).
CREATE OR REPLACE FUNCTION public.retainer_extension_maintenance_due(batch_limit integer,candidate_runtime text)
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN public.workspaces w ON w.id=i.workspace_id AND (w.deletion_scheduled_at IS NULL OR i.state='uninstalling')
    WHERE (i.state='uninstalling' AND i.cleanup_deadline<=now())
      OR (NOT EXISTS(SELECT 1 FROM public.extension_runtime_unavailable u
      WHERE u.workspace_id=i.workspace_id AND u.installation_id=i.id AND u.runtime_identity=$2
        AND u.generation=i.generation AND u.release_digest=i.release_digest) AND (
        (i.state='uninstalling' AND i.cleanup_deadline>now() AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j
          WHERE j.workspace_id=i.workspace_id AND j.installation_id=i.id AND j.generation=i.generation AND j.trigger_kind='uninstall'))
        OR (i.state='active' AND (NOT EXISTS(SELECT 1 FROM public.extension_schedules s
        WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id)
        OR EXISTS(SELECT 1 FROM public.extension_schedules s WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id AND s.next_due_at<=now())))))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_runtime_due(batch_limit integer,candidate_runtime text)
RETURNS TABLE(workspace_id uuid,installation_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT u.workspace_id,u.installation_id FROM public.extension_runtime_unavailable u
  JOIN public.extension_installations i ON i.workspace_id=u.workspace_id AND i.id=u.installation_id
    AND i.generation=u.generation AND i.release_digest=u.release_digest
  JOIN public.workspaces w ON w.id=u.workspace_id AND (w.deletion_scheduled_at IS NULL OR i.state='uninstalling')
  WHERE u.runtime_identity=$2 AND u.retry_at<=now()
    AND (i.state IN ('active','installing','upgrading') OR i.state='uninstalling' AND i.cleanup_deadline>now())
  ORDER BY u.retry_at,u.installation_id LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
-- A cleanup run may still read the provider connection's secrets while its
-- workspace is being deleted; nothing else is admitted there.
CREATE OR REPLACE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_writing boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  current_state text;
  cleanup_live boolean;
  deleting boolean;
  job_trigger text;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  SELECT i.state,i.cleanup_deadline>clock_timestamp(),w.deletion_scheduled_at IS NOT NULL INTO current_state,cleanup_live,deleting
    FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.generation=p_generation AND i.release_digest=p_release;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind INTO job_trigger FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN (NOT deleting AND job_trigger NOT IN ('install','uninstall') AND current_state='active')
    OR (NOT deleting AND job_trigger='install' AND current_state IN ('installing','upgrading'))
    OR (NOT p_writing AND job_trigger='uninstall' AND current_state='uninstalling' AND cleanup_live IS TRUE);
END $$;
--> statement-breakpoint
-- The hard delete of a deleted workspace waits while any of its installations
-- is not yet uninstalling, or is uninstalling within its cleanup deadline.
CREATE FUNCTION public.retainer_workspace_extension_cleanup_pending(p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=p_workspace
    AND (i.state NOT IN ('uninstalling','uninstalled') OR (i.state='uninstalling' AND i.cleanup_deadline>clock_timestamp())))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_workspace_extension_cleanup_pending(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_workspace_extension_cleanup_pending(uuid) TO retainer_control;
