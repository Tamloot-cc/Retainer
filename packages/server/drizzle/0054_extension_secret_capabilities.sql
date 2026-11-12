GRANT SELECT, INSERT, UPDATE, DELETE ON extension_pending_secrets, extension_secrets TO retainer_secret_broker;
--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_pending_secrets(refs uuid[])
  RETURNS TABLE(id uuid, draft_installation_id uuid, registration_id uuid, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT s.id,s.draft_installation_id,s.registration_id,s.name FROM public.extension_pending_secrets s
    WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND s.id=ANY(refs) AND s.expires_at>clock_timestamp() AND s.consumed_at IS NULL
  $$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_secret_names(installation uuid)
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT coalesce(array_agg(s.name ORDER BY s.name),'{}'::text[]) FROM public.extension_secrets s
    WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND s.installation_id=installation AND s.delete_after IS NULL
  $$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_adopt_extension_secret(pending uuid, installation uuid, registration uuid, key_name text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  staged public.extension_pending_secrets;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant
      AND i.id=installation AND i.registration_id=registration AND i.state='disabled') THEN RETURN false; END IF;
    SELECT * INTO staged FROM public.extension_pending_secrets s WHERE s.workspace_id=tenant AND s.id=pending
      AND s.draft_installation_id=installation AND s.registration_id=registration AND s.name=key_name
      AND s.consumed_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.extension_secrets(workspace_id,installation_id,name,envelope)
      VALUES(tenant,installation,key_name,staged.envelope)
      ON CONFLICT(workspace_id,installation_id,name) DO UPDATE SET envelope=excluded.envelope,
        revision=extension_secrets.revision+1,delete_after=NULL;
    UPDATE public.extension_pending_secrets SET consumed_at=clock_timestamp() WHERE id=pending AND workspace_id=tenant;
    RETURN true;
  END $$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_retire_extension_secrets(installation uuid)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    UPDATE public.extension_secrets s SET delete_after=clock_timestamp()+interval '24 hours'
      WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND s.installation_id=installation
        AND EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=s.workspace_id AND i.id=installation AND i.state='uninstalled')
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_pending_secrets(uuid[]),public.retainer_extension_secret_names(uuid),
  public.retainer_adopt_extension_secret(uuid,uuid,uuid,text),public.retainer_retire_extension_secrets(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_pending_secrets(uuid[]),public.retainer_extension_secret_names(uuid),
  public.retainer_adopt_extension_secret(uuid,uuid,uuid,text),public.retainer_retire_extension_secrets(uuid) TO retainer_app;
