-- Whether a routine is running or waiting on a record, or on a record merged
-- into it, other than the given run (routines spec §6.2): one run of a
-- routine on a record at a time. The claim and due-run discovery both ask
-- it, so they agree on which runs wait. It reads as its caller: under a
-- workspace's RLS in the claim, as the owner in discovery.
CREATE FUNCTION public.retainer_routine_record_busy(routine uuid,record uuid,except_run uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.routine_runs b
    WHERE b.routine_id=routine AND b.mode='run' AND b.status IN ('running','waiting') AND b.id<>except_run
      AND (b.record_id=record
        OR b.record_id IN (SELECT x.id FROM public.records x WHERE x.merged_into_id=record)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_record_busy(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_routine_record_busy(uuid,uuid,uuid) TO retainer_app;
--> statement-breakpoint
-- Due-run discovery leaves out a queued run that the claim would skip, so a
-- backlog of manual runs on one busy record no longer fills every batch and
-- delays runnable work in other workspaces (#131). A running run whose lease
-- expired is still due itself, and the runs it blocks follow once it ends.
CREATE OR REPLACE FUNCTION public.retainer_routine_runs_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid,run_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.workspace_id,r.id FROM public.routine_runs r
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  LEFT JOIN public.records m ON m.id=r.record_id
  WHERE ((r.status='queued' AND r.available_at<=now()) OR (r.status='running' AND r.lease_until<=now()))
    AND NOT (r.status='queued' AND r.mode='run' AND r.routine_id IS NOT NULL AND r.record_id IS NOT NULL
      AND public.retainer_routine_record_busy(r.routine_id,coalesce(m.merged_into_id,r.record_id),r.id))
  ORDER BY r.available_at,r.id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
