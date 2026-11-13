-- Null-scope workspace secrets keep their original authenticated encryption identity.
-- Member secret staging/admission is added with the member lifecycle; the old
-- workspace adoption capability cannot consume a member draft.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.extension_connections TO retainer_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_adopt_extension_secret(pending uuid, installation uuid, registration uuid, key_name text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  staged public.extension_pending_secrets;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant
      AND i.id=installation AND i.registration_id=registration AND i.state IN ('disabled','installing','upgrading')) THEN RETURN false; END IF;
    SELECT * INTO staged FROM public.extension_pending_secrets s WHERE s.workspace_id=tenant AND s.id=pending
      AND s.draft_installation_id=installation AND s.registration_id=registration AND s.name=key_name
      AND s.connection_id IS NULL AND s.consumed_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.extension_secrets(workspace_id,installation_id,name,envelope)
      VALUES(tenant,installation,key_name,staged.envelope)
      ON CONFLICT(workspace_id,installation_id,connection_id,name) DO UPDATE SET envelope=excluded.envelope,
        revision=extension_secrets.revision+1,delete_after=NULL;
    UPDATE public.extension_pending_secrets SET consumed_at=clock_timestamp() WHERE id=pending AND workspace_id=tenant;
    RETURN true;
  END $$;


