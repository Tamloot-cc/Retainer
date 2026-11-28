-- Due-run discovery leaves out a queued run that the claim would skip: one
-- whose routine is already running or waiting on the same record, the
-- record it was merged into included (routines spec §6.2). A backlog of
-- manual runs on one busy record no longer fills every batch and delays
-- runnable work in other workspaces (#131). A running run whose lease
-- expired is still due itself, and the runs it blocks follow once it ends.
CREATE OR REPLACE FUNCTION public.retainer_routine_runs_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid,run_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.workspace_id,r.id FROM public.routine_runs r
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE ((r.status='queued' AND r.available_at<=now()) OR (r.status='running' AND r.lease_until<=now()))
    AND NOT (r.status='queued' AND r.mode='run' AND r.routine_id IS NOT NULL AND r.record_id IS NOT NULL
      AND EXISTS(
        SELECT 1 FROM public.routine_runs b
        WHERE b.routine_id=r.routine_id AND b.mode='run' AND b.status IN ('running','waiting') AND b.id<>r.id
          AND b.record_id IN (
            SELECT s.id FROM (SELECT coalesce(
              (SELECT m.merged_into_id FROM public.records m WHERE m.id=r.record_id), r.record_id) AS id) s
            UNION ALL
            SELECT x.id FROM public.records x WHERE x.merged_into_id=coalesce(
              (SELECT m.merged_into_id FROM public.records m WHERE m.id=r.record_id), r.record_id))))
  ORDER BY r.available_at,r.id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
