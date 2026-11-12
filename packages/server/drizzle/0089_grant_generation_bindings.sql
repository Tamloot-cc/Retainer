-- Credentials issued so far bound to generation; carry that value over so exactly the currently valid ones stay valid.
UPDATE extension_installations SET grant_generation=generation WHERE grant_generation<>generation;
--> statement-breakpoint
-- Standalone keys bind the reviewed grant, not the release: upgrades and settings changes keep them.
CREATE OR REPLACE FUNCTION retainer_lookup_extension_key(hashed text)
RETURNS TABLE(credential_id uuid,workspace_id uuid,installation_id uuid,registration_id uuid,generation integer,actor_type text,scopes jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT c.id,c.workspace_id,c.installation_id,i.registration_id,i.grant_generation,i.granted_actor,c.scopes
  FROM public.extension_credentials c JOIN public.extension_installations i
    ON i.workspace_id=c.workspace_id AND i.id=c.installation_id
  JOIN public.workspaces w ON w.id=c.workspace_id
  WHERE c.kind='key' AND c.key_hash=hashed AND c.revoked_at IS NULL
    AND c.generation=i.grant_generation AND i.state='active' AND w.deletion_scheduled_at IS NULL
    AND c.scopes <@ i.granted_scopes
$$;
--> statement-breakpoint
-- The issuer resolves one library reference without gaining access to CRM rows or key hashes.
CREATE OR REPLACE FUNCTION retainer_oauth_reference(reference uuid)
RETURNS TABLE(kind text,workspace_id uuid,credential_id uuid,installation_id uuid,registration_id uuid,
  generation integer,actor_type text,scopes jsonb,client_id text,subject_id text,active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.kind,r.workspace_id,c.id,c.installation_id,i.registration_id,c.generation,i.granted_actor,c.scopes,c.client_id,c.subject_id,
    CASE WHEN r.kind='person' THEN w.deletion_scheduled_at IS NULL
      ELSE c.id IS NOT NULL AND c.revoked_at IS NULL AND NOT c.pending AND c.generation=i.grant_generation
        AND i.state='active' AND c.scopes <@ i.granted_scopes
        AND cl.client_id IS NOT NULL AND cl.disabled IS NOT TRUE AND w.deletion_scheduled_at IS NULL END
  FROM public.oauth_grant_references r JOIN public.workspaces w ON w.id=r.workspace_id
  LEFT JOIN public.extension_credentials c ON c.id=r.credential_id AND c.workspace_id=r.workspace_id AND c.kind='oauth'
  LEFT JOIN public.extension_installations i ON i.id=c.installation_id AND i.workspace_id=c.workspace_id
  LEFT JOIN public.oauth_clients cl ON cl.client_id=c.client_id
  WHERE r.id=reference
$$;
