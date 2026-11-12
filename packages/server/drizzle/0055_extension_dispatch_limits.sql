-- A short global dispatch lock serializes capacity admission, never provider execution.
CREATE FUNCTION public.retainer_extension_slot_available(candidate uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_jobs j WHERE j.id=candidate AND j.workspace_id=tenant) THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(21063,0);
    RETURN (SELECT count(*) FROM public.extension_jobs j WHERE j.status='running' AND j.id<>candidate AND j.lease_until>clock_timestamp())<32
      AND (SELECT count(*) FROM public.extension_jobs j WHERE j.workspace_id=tenant AND j.status='running' AND j.id<>candidate AND j.lease_until>clock_timestamp())<4;
  END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_slot_available(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_slot_available(uuid) TO retainer_app;
--> statement-breakpoint
-- One candidate per installation prevents a large backfill from filling every discovery batch.
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer)
  RETURNS TABLE(workspace_id uuid, job_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    WITH candidates AS (
      SELECT DISTINCT ON(j.workspace_id,j.installation_id) j.workspace_id,j.id,j.available_at
      FROM public.extension_jobs j
      JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
      JOIN public.workspaces w ON w.id=j.workspace_id AND w.deletion_scheduled_at IS NULL
      WHERE i.state='active' AND j.generation=i.generation AND j.release_digest=i.release_digest
        AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
        AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
          AND r.installation_id=j.installation_id AND r.status='running' AND r.id<>j.id)
      ORDER BY j.workspace_id,j.installation_id,j.available_at,j.id
    ) SELECT c.workspace_id,c.id FROM candidates c ORDER BY c.available_at,c.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
