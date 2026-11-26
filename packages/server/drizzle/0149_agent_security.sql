-- The workspace agent (docs/specs/agent.md §5): its session tables for the
-- runtime role, the `retainer_mastra` role and the `mastra` schema its store
-- lives in, and the functions that check a chat's person, erase stored
-- agent content and find maintenance work.
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_sessions,public.agent_turns,
  public.agent_stream_tokens,public.agent_days TO retainer_app;
--> statement-breakpoint
-- The agent runtime's only database role (§3.2, D8): USAGE and DML on the
-- `mastra` schema, no grants on `public`, a member of no other role. Roles
-- are cluster-wide, so create it only once. The migration role is a member
-- of it, not the reverse, so operator tooling and tests can switch to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_mastra') THEN
    CREATE ROLE retainer_mastra NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT retainer_mastra TO CURRENT_USER;
--> statement-breakpoint
-- Mastra's tables are created here by the migration step (`init()` after
-- these migrations, as the migration role), never at runtime. Drizzle
-- doesn't manage them.
CREATE SCHEMA IF NOT EXISTS mastra;
--> statement-breakpoint
REVOKE ALL ON SCHEMA mastra FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA mastra TO retainer_mastra;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA mastra GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO retainer_mastra;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA mastra GRANT USAGE,SELECT ON SEQUENCES TO retainer_mastra;
--> statement-breakpoint
-- A chat's person, re-checked on every call the agent makes for them (§7.3):
-- their name and current role in the workspace, or no role once removed,
-- disabled or the workspace deleted. With a CLI login, the login must still
-- be live too.
CREATE FUNCTION public.retainer_agent_access(subject uuid, workspace uuid, login uuid)
RETURNS TABLE(user_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT u.name,
    CASE WHEN om.role IN ('owner', 'admin') THEN 'admin' WHEN om.role = 'member' THEN wm.role END
  FROM public.users u
  JOIN public.workspaces w ON w.id = workspace AND w.deletion_scheduled_at IS NULL
  LEFT JOIN public.organization_members om ON om.organization_id = w.organization_id AND om.user_id = u.id
  LEFT JOIN public.workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
  WHERE u.id = subject AND u.disabled_at IS NULL
    AND (login IS NULL OR EXISTS (
      SELECT 1 FROM public.cli_logins l
      JOIN public.oauth_clients cl ON cl.client_id = 'retainer-cli' AND cl.disabled IS NOT TRUE
      WHERE l.id = login AND l.user_id = subject AND l.revoked_at IS NULL))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_agent_access(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_agent_access(uuid, uuid, uuid) TO retainer_app;
--> statement-breakpoint
-- The one erasure of stored agent content (§5.4): chat delete and retention
-- (as retainer_app) and the hard purge (as retainer_control). It deletes the
-- sessions' rows from every table in the `mastra` schema by their real keys:
-- a thread and its resource are the session ID, runs are the claims' run IDs.
-- `sessions` null means the whole workspace; listed sessions of another
-- workspace are ignored. The transaction must be scoped to the workspace.
-- A test fails if a table in `mastra` is missing here.
CREATE FUNCTION public.retainer_erase_agent_content(workspace uuid, sessions uuid[])
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  ids text[];
  runs text[];
  erased integer := 0;
  n integer;
BEGIN
  IF workspace IS NULL
    OR workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'erasing agent content needs its workspace scope' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(array_agg(s.id::text), '{}') INTO ids FROM public.agent_sessions s
  WHERE s.workspace_id = workspace AND (sessions IS NULL OR s.id = ANY(sessions));
  -- No session, or Mastra's tables were never created on this database.
  IF cardinality(ids) = 0 OR to_regclass('mastra.mastra_threads') IS NULL THEN
    RETURN 0;
  END IF;
  SELECT coalesce(array_agg(t.run_id::text), '{}') INTO runs FROM public.agent_turns t
  WHERE t.workspace_id = workspace AND t.session_id::text = ANY(ids);
  DELETE FROM mastra.mastra_messages WHERE thread_id = ANY(ids) OR "resourceId" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_threads WHERE id = ANY(ids) OR "resourceId" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_resources WHERE id = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_observational_memory WHERE "threadId" = ANY(ids) OR "resourceId" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_memory_run_fences WHERE "runId" = ANY(runs);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_workflow_snapshot WHERE run_id = ANY(runs) OR "resourceId" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_workflow_runs
  WHERE run_id = ANY(runs) OR "threadId" = ANY(ids) OR "resourceId" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_workflow_run_entries WHERE run_id = ANY(runs);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  DELETE FROM mastra.mastra_workflow_run_owners WHERE "runId" = ANY(runs);
  GET DIAGNOSTICS n = ROW_COUNT; erased := erased + n;
  RETURN erased;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_erase_agent_content(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_erase_agent_content(uuid, uuid[]) TO retainer_app, retainer_control;
--> statement-breakpoint
-- Mastra rows whose thread or resource is no longer a session, or whose run
-- is no longer on agent_turns (§5.4): a step a deleted chat's turn saved
-- after the erasure. The daily sweep runs it.
CREATE FUNCTION public.retainer_sweep_agent_orphans()
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  swept integer := 0;
  n integer;
BEGIN
  IF to_regclass('mastra.mastra_threads') IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM mastra.mastra_messages m
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_sessions s WHERE s.id::text = m.thread_id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_threads x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_sessions s WHERE s.id::text = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_resources x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_sessions s WHERE s.id::text = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_observational_memory x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_sessions s
    WHERE s.id::text = x."resourceId" OR s.id::text = x."threadId");
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_memory_run_fences x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.run_id::text = x."runId");
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_workflow_snapshot x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.run_id::text = x.run_id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_workflow_runs x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.run_id::text = x.run_id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_workflow_run_entries x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.run_id::text = x.run_id);
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  DELETE FROM mastra.mastra_workflow_run_owners x
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_turns t WHERE t.run_id::text = x."runId");
  GET DIAGNOSTICS n = ROW_COUNT; swept := swept + n;
  RETURN swept;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_sweep_agent_orphans() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_sweep_agent_orphans() TO retainer_app;
--> statement-breakpoint
-- Workspaces with agent upkeep due (§5.4, §6.3): a turn whose runtime
-- vanished (running past its deadline plus the 60-second grace), an expired
-- stream token, or a task session past its 7 days. IDs only.
CREATE FUNCTION public.retainer_agent_maintenance_due(batch_limit integer)
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
  ) x
  LIMIT least(greatest(batch_limit, 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_agent_maintenance_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_agent_maintenance_due(integer) TO retainer_executor;
