-- The issuer resolves one library reference without gaining access to CRM rows or key hashes.
CREATE OR REPLACE FUNCTION retainer_oauth_reference(reference uuid)
RETURNS TABLE(kind text,workspace_id uuid,credential_id uuid,installation_id uuid,registration_id uuid,
  generation integer,actor_type text,scopes jsonb,client_id text,subject_id text,active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT r.kind,r.workspace_id,c.id,c.installation_id,i.registration_id,c.generation,i.granted_actor,c.scopes,c.client_id,c.subject_id,
    CASE WHEN r.kind='person' THEN w.deletion_scheduled_at IS NULL
      ELSE c.id IS NOT NULL AND c.revoked_at IS NULL AND NOT c.pending AND c.generation=i.generation
        AND i.state='active' AND c.scopes <@ i.granted_scopes
        AND cl.client_id IS NOT NULL AND cl.disabled IS NOT TRUE AND w.deletion_scheduled_at IS NULL END
  FROM public.oauth_grant_references r JOIN public.workspaces w ON w.id=r.workspace_id
  LEFT JOIN public.extension_credentials c ON c.id=r.credential_id AND c.workspace_id=r.workspace_id AND c.kind='oauth'
  LEFT JOIN public.extension_installations i ON i.id=c.installation_id AND i.workspace_id=c.workspace_id
  LEFT JOIN public.oauth_clients cl ON cl.client_id=c.client_id
  WHERE r.id=reference
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_oauth_reference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retainer_oauth_reference(uuid) TO retainer_control;
