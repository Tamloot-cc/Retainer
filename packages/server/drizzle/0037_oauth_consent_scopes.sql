-- retainer_token_access also returns the scopes the current consent grants
-- (accounts spec 4.7), so a token issued under an earlier consent for the
-- same app, person and workspace can never use more than the person agreed
-- to last time. Its return type changes, so it is dropped and recreated.
DROP FUNCTION "public"."retainer_token_access"(text, text, text);
--> statement-breakpoint
CREATE FUNCTION "public"."retainer_token_access"(subject text, workspace text, client text)
  RETURNS TABLE (
    user_id uuid, user_name text, client_name text, workspace_id uuid, role text, scopes text[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.name, coalesce(c.name, c.client_id), w.id,
      CASE
        WHEN om.role IN ('owner', 'admin') THEN 'admin'
        WHEN om.role = 'member' THEN wm.role
      END,
      oc.scopes
    FROM public.oauth_consents AS oc
    JOIN public.users AS u ON u.id = oc.user_id AND u.disabled_at IS NULL
    JOIN public.oauth_clients AS c ON c.client_id = oc.client_id AND c.disabled IS NOT TRUE
    JOIN public.workspaces AS w ON w.id = oc.reference_id AND w.deletion_scheduled_at IS NULL
    LEFT JOIN public.organization_members AS om
      ON om.organization_id = w.organization_id AND om.user_id = u.id
    LEFT JOIN public.workspace_members AS wm
      ON wm.workspace_id = w.id AND wm.user_id = u.id
    WHERE oc.client_id = client
      AND oc.user_id = CASE WHEN subject ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
        THEN subject::uuid END
      AND oc.reference_id = CASE WHEN workspace ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
        THEN workspace::uuid END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_token_access"(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_token_access"(text, text, text) TO retainer_app;
