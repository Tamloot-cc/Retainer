-- OAuth for MCP (accounts spec 4.7, 4.9). Applied by the migration role,
-- like 0027_accounts_security.
--
-- Better Auth's OAuth tables are account tables: row-level security on, the
-- control role's own policy and grants, and nothing for the runtime role.
-- The API checks OAuth tokens with no internet and no access to these
-- tables, through the two functions below.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jwks', 'oauth_clients', 'oauth_resources', 'oauth_client_resources',
    'oauth_refresh_tokens', 'oauth_access_tokens', 'oauth_consents',
    'oauth_client_assertions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO retainer_control', t);
    EXECUTE format(
      'CREATE POLICY "control_access" ON %I TO retainer_control USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- The public halves of the keys that sign access tokens, so the API can
-- verify a token's signature. Private keys never leave the table.
CREATE FUNCTION "public"."retainer_token_keys"()
  RETURNS TABLE (id uuid, public_key text, alg text, crv text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT k.id, k.public_key, k.alg, k.crv FROM public.jwks AS k
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_token_keys"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_token_keys"() TO retainer_app;
--> statement-breakpoint

-- What a verified access token may do now. The API calls it after checking
-- the token's signature, issuer and audience, with the token's subject (the
-- person), workspace and client. No row: the consent was revoked, or the
-- person is disabled, the app disabled or the workspace deleted. A row with
-- a null role: the person no longer has access to the workspace. Otherwise
-- their effective role (shared/roles.ts), which caps the token's scopes.
-- Malformed IDs match nothing rather than raising.
CREATE FUNCTION "public"."retainer_token_access"(subject text, workspace text, client text)
  RETURNS TABLE (user_id uuid, user_name text, client_name text, workspace_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.name, coalesce(c.name, c.client_id), w.id,
      CASE
        WHEN om.role IN ('owner', 'admin') THEN 'admin'
        WHEN om.role = 'member' THEN wm.role
      END
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
