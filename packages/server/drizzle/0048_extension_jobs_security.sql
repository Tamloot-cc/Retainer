GRANT SELECT, INSERT, UPDATE, DELETE ON extension_jobs, extension_attempts, extension_kv TO retainer_app;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_executor') THEN
    CREATE ROLE retainer_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT retainer_executor TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO retainer_executor;
--> statement-breakpoint
-- The coordinator discovers due IDs only; payloads/claim/load still require a workspace RLS transaction.
CREATE FUNCTION public.retainer_extension_jobs_due(batch_limit integer)
  RETURNS TABLE(workspace_id uuid, job_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT j.workspace_id, j.id FROM public.extension_jobs j
    JOIN public.extension_installations i ON i.id = j.installation_id AND i.workspace_id = j.workspace_id
    JOIN public.workspaces w ON w.id = j.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE i.state = 'active' AND j.generation = i.generation AND j.release_digest = i.release_digest
      AND ((j.status = 'queued' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until <= now()))
      AND NOT EXISTS (SELECT 1 FROM public.extension_jobs r
        WHERE r.workspace_id = j.workspace_id AND r.installation_id = j.installation_id
          AND r.status = 'running' AND r.id <> j.id)
    ORDER BY j.available_at, j.id LIMIT least(greatest(batch_limit, 1), 1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_jobs_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_jobs_due(integer) TO retainer_executor;
