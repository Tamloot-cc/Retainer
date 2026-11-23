-- CLI credentials and approvals belong to the control plane. The API sees
-- only the result of checking a verified token and locking its approval.
GRANT SELECT, INSERT, UPDATE, DELETE ON cli_logins, cli_approvals, passkey_change_authorizations TO retainer_control;
CREATE POLICY control_access ON cli_logins TO retainer_control USING (true) WITH CHECK (true);
CREATE POLICY control_access ON cli_approvals TO retainer_control USING (true) WITH CHECK (true);
CREATE POLICY control_access ON passkey_change_authorizations TO retainer_control USING (true) WITH CHECK (true);
GRANT INSERT ON oauth_grant_references TO retainer_control;
CREATE POLICY cli_reference ON oauth_grant_references FOR INSERT TO retainer_control WITH CHECK (kind = 'cli');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION retainer_oauth_reference(reference uuid)
RETURNS TABLE(kind text,workspace_id uuid,credential_id uuid,installation_id uuid,registration_id uuid,
  generation integer,actor_type text,scopes jsonb,client_id text,subject_id text,active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.kind,r.workspace_id,c.id,c.installation_id,i.registration_id,c.generation,i.granted_actor,c.scopes,
    CASE WHEN r.kind='cli' THEN 'retainer-cli' ELSE c.client_id END,
    CASE WHEN r.kind='cli' THEN u.id::text ELSE c.subject_id END,
    CASE
      WHEN r.kind='cli' THEN u.id IS NOT NULL AND l.revoked_at IS NULL
      WHEN r.kind='person' THEN w.id IS NOT NULL AND w.deletion_scheduled_at IS NULL
      ELSE c.id IS NOT NULL AND c.revoked_at IS NULL AND NOT c.pending AND c.generation=i.grant_generation
        AND i.state='active' AND c.scopes <@ i.granted_scopes
        AND cl.client_id IS NOT NULL AND cl.disabled IS NOT TRUE AND w.deletion_scheduled_at IS NULL
    END
  FROM public.oauth_grant_references r LEFT JOIN public.workspaces w ON w.id=r.workspace_id
  LEFT JOIN public.extension_credentials c ON c.id=r.credential_id AND c.workspace_id=r.workspace_id AND c.kind='oauth'
  LEFT JOIN public.extension_installations i ON i.id=c.installation_id AND i.workspace_id=c.workspace_id
  LEFT JOIN public.oauth_clients cl ON cl.client_id=c.client_id
  LEFT JOIN public.cli_logins l ON l.id=r.cli_login_id
  LEFT JOIN public.users u ON u.id=l.user_id AND u.disabled_at IS NULL
  WHERE r.id=reference
$$;
--> statement-breakpoint
CREATE FUNCTION retainer_cli_access(subject uuid, client text, login uuid, workspace uuid)
RETURNS TABLE(user_id uuid, user_name text, workspace_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT u.id, u.name, w.id,
    CASE WHEN om.role IN ('admin', 'owner') THEN 'admin' WHEN om.role = 'member' THEN wm.role END
  FROM public.cli_logins l
  JOIN public.users u ON u.id = l.user_id AND u.disabled_at IS NULL
  JOIN public.oauth_clients cl ON cl.client_id = client AND cl.disabled IS NOT TRUE
  LEFT JOIN public.workspaces w ON w.id = workspace AND w.deletion_scheduled_at IS NULL
  LEFT JOIN public.organization_members om ON om.organization_id = w.organization_id AND om.user_id = u.id
  LEFT JOIN public.workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
  WHERE client = 'retainer-cli' AND l.id = login AND l.user_id = subject AND l.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION retainer_cli_access(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retainer_cli_access(uuid, text, uuid, uuid) TO retainer_app;
--> statement-breakpoint
CREATE FUNCTION retainer_cli_elevation(subject uuid, login uuid, approval uuid, required_role text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  target uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  deadline timestamptz;
BEGIN
  SELECT a.expires_at INTO deadline
  FROM public.cli_approvals a
  WHERE (approval IS NULL OR a.id = approval) AND a.login_id = login AND a.workspace_id = target
    AND a.kind = 'elevation' AND a.status = 'approved' AND a.expires_at > clock_timestamp()
  ORDER BY a.expires_at DESC, a.id
  LIMIT 1
  FOR SHARE;
  IF deadline IS NULL OR deadline <= clock_timestamp() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.retainer_cli_access(subject, 'retainer-cli', login, target) AS access
    WHERE access.role = 'admin' OR (required_role = 'editor' AND access.role = 'editor')
  );
END
$$;
REVOKE ALL ON FUNCTION retainer_cli_elevation(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retainer_cli_elevation(uuid, uuid, uuid, text) TO retainer_app;
--> statement-breakpoint
CREATE FUNCTION retainer_guard_passkey_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  person uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.user_id ELSE OLD.user_id END;
  credential text;
BEGIN
  PERFORM 1 FROM public.users u WHERE u.id = person FOR UPDATE;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.passkeys p WHERE p.user_id = person) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (
    NOT FOUND OR (
      current_setting('app.operator_clear_passkeys', true) = 'true'
      AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
    )
  ) THEN
    RETURN OLD;
  END IF;
  credential := CASE WHEN TG_OP = 'INSERT'
    THEN NEW.credential_id || ':' || encode(sha256(decode(NEW.public_key, 'base64')), 'hex')
    ELSE OLD.credential_id END;
  DELETE FROM public.passkey_change_authorizations
  WHERE user_id = person AND credential_id = credential AND kind = lower(TG_OP)
    AND expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An enrolled passkey must authorize this change' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END;
END
$$;
CREATE TRIGGER retainer_guard_passkey_change BEFORE INSERT OR DELETE ON passkeys
FOR EACH ROW EXECUTE FUNCTION retainer_guard_passkey_change();
