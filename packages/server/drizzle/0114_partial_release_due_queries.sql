-- Same rules as 0113, cheaper plans. Maintenance finds overdue partial release
-- jobs from the jobs side, where extension_jobs_expiry_idx serves the lookup,
-- instead of probing every installation's job history. Auto-upgrade scans an
-- installation's open disconnect jobs once instead of twice.
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
      OR (i.workspace_id,i.id) IN (SELECT j.workspace_id,j.installation_id FROM public.extension_jobs j
        WHERE j.status IN ('queued','running') AND j.expires_at<=now()
        AND public.retainer_partial_release_job(j.trigger_kind,j.input)
        AND (j.status='queued' OR j.lease_until<=now()))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
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
        AND (NOT public.retainer_partial_release_job(j.trigger_kind,j.input) OR public.retainer_partial_release_blocking(j)))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
