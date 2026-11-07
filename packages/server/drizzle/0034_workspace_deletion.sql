-- A deleted workspace is gone for every lookup at once (accounts spec 4.5,
-- "Deleting"), though its rows stay until a scheduled run removes them.
-- Sessions already refuse it (0031). Same signatures and grants as before,
-- so CREATE OR REPLACE keeps them.

-- An API key of a deleted workspace is refused, as if revoked.
CREATE OR REPLACE FUNCTION "public"."retainer_lookup_api_key"(key_hash text)
  RETURNS TABLE (key_id uuid, workspace_id uuid, scopes text[], actor jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT k.id, k.workspace_id, k.scopes, k.actor
    FROM public.api_keys AS k
    JOIN public.workspaces AS w ON w.id = k.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE k.hash = key_hash AND k.revoked_at IS NULL
  $$;
--> statement-breakpoint

-- The consolidator skips a deleted workspace.
CREATE OR REPLACE FUNCTION "public"."retainer_workspaces_due"(min_interval interval)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT w.id
    FROM public.workspaces AS w
    LEFT JOIN public.consolidator_runs AS r ON r.workspace_id = w.id
    WHERE w.deletion_scheduled_at IS NULL
      AND (r.started_at IS NULL OR r.started_at < now() - min_interval)
    ORDER BY r.started_at NULLS FIRST, w.id
  $$;
