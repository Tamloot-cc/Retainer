-- Routines (docs/specs/routines.md §6.6): the runtime role reads and writes
-- the routine tables under their row-level security policies, and the
-- executor role discovers due work through these functions, which return IDs
-- only.
GRANT SELECT,INSERT,UPDATE,DELETE ON public.routine_sources,public.routines,public.routine_versions,
  public.routine_runs,public.routine_run_results,public.routine_firings,public.routine_model_days TO retainer_app;
--> statement-breakpoint
CREATE FUNCTION public.retainer_routine_runs_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid,run_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.workspace_id,r.id FROM public.routine_runs r
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE (r.status='queued' AND r.available_at<=now()) OR (r.status='running' AND r.lease_until<=now())
  ORDER BY r.available_at,r.id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_runs_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_runs_due(integer) TO retainer_executor;
--> statement-breakpoint
-- Workspaces with an active routine whose feed cursor is behind the head
-- (§6.1). It needs no extension installation.
CREATE FUNCTION public.retainer_routine_changes_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT DISTINCT r.workspace_id FROM public.routines r
  JOIN public.change_counters c ON c.workspace_id=r.workspace_id AND c.position>coalesce(r.feed_position,0)
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE r.status='active' AND r.feed_position IS NOT NULL
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_changes_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_changes_due(integer) TO retainer_executor;
--> statement-breakpoint
CREATE FUNCTION public.retainer_routine_schedules_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid,routine_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.workspace_id,r.id FROM public.routines r
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE r.status='active' AND r.next_fire_at<=now()
  ORDER BY r.next_fire_at,r.id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_schedules_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_schedules_due(integer) TO retainer_executor;
--> statement-breakpoint
-- Workspaces with stored results or run output past their 7 days, or finished runs past 30.
CREATE FUNCTION public.retainer_routine_retention_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT DISTINCT r.workspace_id FROM public.routine_runs r
  WHERE r.finished_at<now()-interval '7 days'
    AND (r.finished_at<now()-interval '30 days' OR r.output IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.routine_run_results x WHERE x.run_id=r.id AND x.result IS NOT NULL))
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_retention_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_retention_due(integer) TO retainer_executor;
--> statement-breakpoint
-- Whether someone is still an admin of the workspace (routines spec §5.3): a
-- person's user ID in accounts mode, or `key:<actor ID>` for an admin API key.
-- An approver who stops being one pauses the routine; a test run's initiator
-- who stops being one ends the test.
CREATE FUNCTION public.retainer_routine_admin(workspace uuid,who text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN who LIKE 'key:%' THEN EXISTS(SELECT 1 FROM public.api_keys k
      WHERE k.workspace_id=workspace AND k.revoked_at IS NULL AND 'admin'=ANY(k.scopes)
        AND k.actor->>'type'='user' AND k.actor->>'id'=substr(who,5))
    ELSE EXISTS(SELECT 1 FROM public.workspaces w
      JOIN public.organization_members om ON om.organization_id=w.organization_id
      LEFT JOIN public.workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=om.user_id
      WHERE w.id=workspace AND om.user_id::text=who AND (om.role IN ('owner','admin') OR wm.role='admin'))
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_admin(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_admin(uuid,text) TO retainer_app;
--> statement-breakpoint
-- The workspace time zone (routines spec §7): the runtime role may set this
-- one key of its own workspace's settings, and nothing else in them.
CREATE FUNCTION public.retainer_set_workspace_time_zone(zone text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  UPDATE public.workspaces SET settings=settings||jsonb_build_object('timeZone',zone),updated_at=clock_timestamp()
  WHERE id=nullif(current_setting('app.workspace_id',true),'')::uuid AND length(zone) BETWEEN 1 AND 100
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_set_workspace_time_zone(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_set_workspace_time_zone(text) TO retainer_app;
