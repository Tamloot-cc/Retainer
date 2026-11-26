-- Agent tasks (docs/specs/agent.md §9): the runtime role's access to their
-- table, the discovery function that hands due task jobs to the agent
-- runtime, and maintenance discovery for tasks and runs waiting past their
-- expiry.
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_tasks TO retainer_app;
--> statement-breakpoint
-- Task jobs to deliver (§9.3): queued and due, or handed out and never
-- claimed or closed before their lease ran out. Expired tasks are left to
-- maintenance, which ends them.
CREATE FUNCTION public.retainer_agent_tasks_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid, session_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT t.workspace_id, t.session_id FROM public.agent_tasks t
  JOIN public.workspaces w ON w.id = t.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE t.expires_at > now()
    AND ((t.state = 'queued' AND t.available_at <= now())
      OR (t.state = 'running' AND t.lease_until <= now()))
  ORDER BY t.available_at
  LIMIT least(greatest(batch_limit, 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_agent_tasks_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_agent_tasks_due(integer) TO retainer_executor;
--> statement-breakpoint
-- As in 0149, plus tasks past their expiry and routine runs still waiting
-- past theirs (§9.2): maintenance ends both.
CREATE OR REPLACE FUNCTION public.retainer_agent_maintenance_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT DISTINCT x.workspace_id FROM (
    SELECT t.workspace_id FROM public.agent_turns t
    WHERE t.status = 'running' AND t.deadline <= now() - interval '60 seconds'
    UNION ALL
    SELECT k.workspace_id FROM public.agent_stream_tokens k WHERE k.expires_at <= now()
    UNION ALL
    SELECT s.workspace_id FROM public.agent_sessions s
    WHERE s.kind = 'task' AND s.last_active_at <= now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.session_id = s.id AND t.status = 'running')
    UNION ALL
    SELECT s.workspace_id FROM public.agent_sessions s
    WHERE s.status = 'deleted'
      AND NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.session_id = s.id
        AND t.stopped_at IS NULL AND t.deadline + interval '60 seconds' > now())
    UNION ALL
    SELECT k.workspace_id FROM public.agent_tasks k
    WHERE k.state IN ('staged', 'queued', 'running') AND k.expires_at <= now()
    UNION ALL
    SELECT k.workspace_id FROM public.agent_tasks k
    WHERE k.state = 'running' AND k.lease_until <= now() AND k.attempts >= 3
    UNION ALL
    SELECT r.workspace_id FROM public.routine_runs r
    WHERE r.status = 'waiting' AND r.expires_at <= now()
  ) x
  LIMIT least(greatest(batch_limit, 1), 1000)
$$;
