-- The workspaces the person behind an MCP OAuth token can reach, for the
-- list_workspaces tool (accounts spec 4.7). It answers only while the token's
-- own consent still gives access, the same check as retainer_token_access,
-- and returns each workspace's name and the person's role there. The runtime
-- role cannot read the account tables, so this is SECURITY DEFINER.
CREATE FUNCTION "public"."retainer_token_workspaces"(subject text, workspace text, client text)
  RETURNS TABLE (workspace_id uuid, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT w.id, w.name,
      CASE
        WHEN om.role IN ('owner', 'admin') THEN 'admin'
        ELSE wm.role
      END
    FROM public.retainer_token_access(subject, workspace, client) AS a
    JOIN public.organization_members AS om ON om.user_id = a.user_id
    JOIN public.workspaces AS w
      ON w.organization_id = om.organization_id AND w.deletion_scheduled_at IS NULL
    LEFT JOIN public.workspace_members AS wm
      ON wm.workspace_id = w.id AND wm.user_id = a.user_id
    WHERE a.role IS NOT NULL
      AND (om.role IN ('owner', 'admin') OR wm.role IS NOT NULL)
    ORDER BY w.name, w.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_token_workspaces"(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_token_workspaces"(text, text, text) TO retainer_app;
