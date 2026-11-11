GRANT SELECT,INSERT,UPDATE,DELETE ON extension_credentials TO retainer_app;
--> statement-breakpoint
-- Authentication sees only a current standalone key binding, never hashes or the credential table.
CREATE FUNCTION retainer_lookup_extension_key(hashed text)
RETURNS TABLE(credential_id uuid,workspace_id uuid,installation_id uuid,registration_id uuid,generation integer,actor_type text,scopes jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT c.id,c.workspace_id,c.installation_id,i.registration_id,i.generation,i.granted_actor,c.scopes
  FROM public.extension_credentials c JOIN public.extension_installations i
    ON i.workspace_id=c.workspace_id AND i.id=c.installation_id
  JOIN public.workspaces w ON w.id=c.workspace_id
  WHERE c.kind='key' AND c.key_hash=hashed AND c.revoked_at IS NULL
    AND c.generation=i.generation AND i.state='active' AND w.deletion_scheduled_at IS NULL
    AND c.scopes <@ i.granted_scopes
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_lookup_extension_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retainer_lookup_extension_key(text) TO retainer_app;
--> statement-breakpoint
-- The row lock lasts through the calling admitted transaction, so disabling a client drains it.
CREATE FUNCTION retainer_extension_oauth_client_active(client text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_client text;
BEGIN
  SELECT client_id INTO found_client FROM public.oauth_clients WHERE client_id=client AND disabled IS NOT TRUE FOR SHARE;
  RETURN found_client IS NOT NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_extension_oauth_client_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retainer_extension_oauth_client_active(text) TO retainer_app;
