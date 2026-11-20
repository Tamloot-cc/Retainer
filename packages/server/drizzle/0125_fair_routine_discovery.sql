-- Use the cursor's update time so a continuously backlogged workspace yields
-- to other workspaces across batches and cold starts.
CREATE OR REPLACE FUNCTION public.retainer_routine_changes_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.workspace_id FROM public.routines r
  JOIN public.change_counters c ON c.workspace_id=r.workspace_id AND c.position>r.feed_position
  JOIN public.workspaces w ON w.id=r.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE r.status='active' AND r.feed_position IS NOT NULL
  GROUP BY r.workspace_id
  ORDER BY min(r.updated_at),r.workspace_id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
