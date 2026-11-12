-- Runtime availability is a stateless filter (extensions review section 4):
-- each worker passes the (registration, release digest) pairs it can run now,
-- and discovery returns only work whose installation is pinned to one of them.
-- Work for any other release stays queued, with no marker, for a worker that
-- can run it. Cleanup-deadline expiry is never filtered, and neither is
-- queueing cleanup, which skips a release this worker cannot run.
DROP FUNCTION public.retainer_extension_runtime_due(integer,text);
--> statement-breakpoint
DROP FUNCTION public.retainer_extension_jobs_due(integer,text);
--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_jobs_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
  RETURNS TABLE(workspace_id uuid, job_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    WITH candidates AS (
      SELECT DISTINCT ON(j.workspace_id,j.installation_id) j.workspace_id,j.id,j.available_at
      FROM public.extension_jobs j
      JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
      JOIN public.workspaces w ON w.id=j.workspace_id AND (w.deletion_scheduled_at IS NULL OR j.trigger_kind='uninstall')
      WHERE (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($2,$3))
        AND ((i.state='active' AND j.trigger_kind NOT IN ('install','uninstall'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')) AND j.generation=i.generation AND j.release_digest=i.release_digest
        AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
        AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
          AND r.installation_id=j.installation_id AND r.status='running' AND r.id<>j.id)
      ORDER BY j.workspace_id,j.installation_id,j.available_at,j.id
    ) SELECT c.workspace_id,c.id FROM candidates c ORDER BY c.available_at,c.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_jobs_due(integer,uuid[],text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_jobs_due(integer,uuid[],text[]) TO retainer_executor;
--> statement-breakpoint
DROP FUNCTION public.retainer_extension_maintenance_due(integer,text);
--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_maintenance_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN public.workspaces w ON w.id=i.workspace_id AND (w.deletion_scheduled_at IS NULL OR i.state='uninstalling')
    WHERE (i.state='uninstalling' AND i.cleanup_deadline<=now())
      OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j
          WHERE j.workspace_id=i.workspace_id AND j.installation_id=i.id AND j.generation=i.generation AND j.trigger_kind='uninstall'))
      OR (i.state='active' AND (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($2,$3))
        AND (NOT EXISTS(SELECT 1 FROM public.extension_schedules s
        WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id)
        OR EXISTS(SELECT 1 FROM public.extension_schedules s WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id AND s.next_due_at<=now())))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_maintenance_due(integer,uuid[],text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_maintenance_due(integer,uuid[],text[]) TO retainer_executor;
--> statement-breakpoint
DROP FUNCTION public.retainer_extension_changes_due(uuid,integer,text);
--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_changes_due(after_id uuid,batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
RETURNS TABLE(workspace_id uuid,installation_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT d.workspace_id,d.installation_id FROM public.change_dispatch d
  JOIN public.extension_installations i ON i.id=d.installation_id AND i.workspace_id=d.workspace_id AND i.generation=d.generation AND i.state='active'
  JOIN public.change_counters c ON c.workspace_id=d.workspace_id AND c.position>d.position
  WHERE (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($3,$4))
  ORDER BY CASE WHEN after_id IS NULL OR d.installation_id>after_id THEN 0 ELSE 1 END,d.installation_id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_changes_due(uuid,integer,uuid[],text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_changes_due(uuid,integer,uuid[],text[]) TO retainer_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_change_retention_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT due.workspace_id FROM (
    SELECT c.workspace_id FROM public.change_counters c WHERE EXISTS(
      SELECT 1 FROM public.record_changes r WHERE r.workspace_id=c.workspace_id AND r.position>c.retained_after
      AND r.created_at<now()-interval '30 days' AND r.position<coalesce((
        SELECT min(fresh.position) FROM public.record_changes fresh WHERE fresh.workspace_id=c.workspace_id AND fresh.created_at>=now()-interval '30 days'
      ),c.position+1))
    UNION SELECT j.workspace_id FROM public.extension_jobs j WHERE j.status IN ('succeeded','failed','cancelled') AND j.updated_at<now()-interval '30 days'
    UNION SELECT j.workspace_id FROM public.extension_jobs j WHERE j.status IN ('queued','running') AND j.expires_at<=now()
      AND (j.status='queued' OR j.lease_until<=now())
    UNION SELECT r.workspace_id FROM public.webhook_receipts r WHERE r.created_at<now()-interval '7 days'
    UNION SELECT b.workspace_id FROM public.webhook_bindings b WHERE b.state='retired' AND b.updated_at<now()-interval '30 days'
  ) due ORDER BY due.workspace_id LIMIT least(greatest(batch_limit,1),1000)
$$;
