-- Automatic extension upgrades (extensions/auto-upgrade.ts). The executor
-- passes, per registration, the newest release it can run. Discovery returns
-- active installations pinned to another release that were not already held
-- for that one and have no disconnect cleanup running; the upgrade itself
-- re-plans and re-checks under the locks.
CREATE FUNCTION public.retainer_extension_upgrades_due(batch_limit integer,target_registrations uuid[],target_digests text[])
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN unnest($2,$3) AS t(registration_id,release_digest) ON t.registration_id=i.registration_id
    JOIN public.workspaces w ON w.id=i.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE i.state='active' AND i.release_digest<>t.release_digest
      AND i.upgrade_held_digest IS DISTINCT FROM t.release_digest
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j WHERE j.workspace_id=i.workspace_id
        AND j.installation_id=i.id AND j.trigger_kind='disconnect' AND j.status IN ('queued','running'))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_upgrades_due(integer,uuid[],text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_upgrades_due(integer,uuid[],text[]) TO retainer_executor;
