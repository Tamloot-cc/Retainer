CREATE OR REPLACE FUNCTION public.retainer_adopt_extension_secret(pending uuid, installation uuid, registration uuid, key_name text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  staged public.extension_pending_secrets;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant
      AND i.id=installation AND i.registration_id=registration AND i.state IN ('disabled','installing','upgrading')) THEN RETURN false; END IF;
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
CREATE OR REPLACE FUNCTION public.retainer_retire_extension_secrets(installation uuid)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    UPDATE public.extension_secrets s SET delete_after=clock_timestamp()+interval '24 hours'
      WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND s.installation_id=installation
        AND EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=s.workspace_id AND i.id=installation AND i.state IN ('uninstalled','uninstalling'))
  $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer)
  RETURNS TABLE(workspace_id uuid, job_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    WITH candidates AS (
      SELECT DISTINCT ON(j.workspace_id,j.installation_id) j.workspace_id,j.id,j.available_at
      FROM public.extension_jobs j
      JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
      JOIN public.workspaces w ON w.id=j.workspace_id AND w.deletion_scheduled_at IS NULL
      WHERE ((i.state='active' AND j.trigger_kind NOT IN ('install','uninstall'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')) AND j.generation=i.generation AND j.release_digest=i.release_digest
        AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
        AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
          AND r.installation_id=j.installation_id AND r.status='running' AND r.id<>j.id)
      ORDER BY j.workspace_id,j.installation_id,j.available_at,j.id
    ) SELECT c.workspace_id,c.id FROM candidates c ORDER BY c.available_at,c.id LIMIT least(greatest(batch_limit,1),1000)
  $$;

--> statement-breakpoint
CREATE FUNCTION public.retainer_finish_extension_cleanup(installation uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant
      AND i.id=installation AND i.state='uninstalled') THEN RETURN; END IF;
    DELETE FROM public.extension_secrets s WHERE s.workspace_id=tenant AND s.installation_id=installation;
    DELETE FROM public.extension_pending_secrets s WHERE s.workspace_id=tenant AND s.draft_installation_id=installation;
  END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_finish_extension_cleanup(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_finish_extension_cleanup(uuid) TO retainer_app;

--> statement-breakpoint
CREATE FUNCTION public.retainer_extension_maintenance_due(batch_limit integer)
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN public.workspaces w ON w.id=i.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE (i.state='uninstalling' AND i.cleanup_deadline<=now())
      OR (i.state='active' AND (NOT EXISTS(SELECT 1 FROM public.extension_schedules s
        WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id)
        OR EXISTS(SELECT 1 FROM public.extension_schedules s WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id AND s.next_due_at<=now())))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_maintenance_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_maintenance_due(integer) TO retainer_executor;
