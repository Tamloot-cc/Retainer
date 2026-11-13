-- Broker admission is independent of API connection liveness. Legacy workspace callers use the default null member scope.
-- A caller without member claims can never admit a member job.
DROP FUNCTION public.retainer_admit_secret_run(uuid,uuid,integer,uuid,text,bigint,text,uuid,text,boolean);
--> statement-breakpoint
CREATE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_function uuid,p_name text,p_writing boolean,p_connection uuid DEFAULT NULL,p_connection_generation integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  current_state text; cleanup_live boolean; deleting boolean; job_trigger text; connection_state text;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  SELECT i.state,i.cleanup_deadline>clock_timestamp(),w.deletion_scheduled_at IS NOT NULL INTO current_state,cleanup_live,deleting
    FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.generation=p_generation AND i.release_digest=p_release;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind INTO job_trigger FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.connection_id IS NOT DISTINCT FROM p_connection AND j.connection_generation IS NOT DISTINCT FROM p_connection_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp()
      AND j.function_id=p_function AND p_name=ANY(j.run_secrets) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_connection IS NOT NULL THEN
    SELECT c.state INTO connection_state FROM public.extension_connections c
      WHERE c.workspace_id=tenant AND c.installation_id=p_installation AND c.id=p_connection AND c.generation=p_connection_generation;
    IF NOT FOUND OR deleting OR current_state<>'active' THEN RETURN false; END IF;
    RETURN (job_trigger='connect' AND connection_state='connecting')
      OR (job_trigger NOT IN ('install','uninstall','connect','disconnect') AND connection_state='active');
  END IF;
  RETURN (NOT deleting AND job_trigger NOT IN ('install','uninstall','connect','disconnect') AND current_state='active')
    OR (NOT deleting AND job_trigger='install' AND current_state IN ('installing','upgrading'))
    OR (NOT p_writing AND job_trigger='uninstall' AND current_state='uninstalling' AND cleanup_live IS TRUE);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_admit_secret_run(uuid,uuid,integer,uuid,text,bigint,text,uuid,text,boolean,uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_admit_secret_run(uuid,uuid,integer,uuid,text,bigint,text,uuid,text,boolean,uuid,integer) TO retainer_secret_broker;
--> statement-breakpoint
CREATE FUNCTION public.retainer_member_pending_secrets(refs uuid[],p_owner text)
RETURNS TABLE(id uuid,draft_installation_id uuid,registration_id uuid,name text,connection_id uuid,owner_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT s.id,s.draft_installation_id,s.registration_id,s.name,s.connection_id,s.owner_id
    FROM public.extension_pending_secrets s
    WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND s.id=ANY(refs) AND s.owner_id=p_owner AND s.connection_id IS NOT NULL
      AND s.created_by->>'type'='user' AND s.created_by->>'id'=p_owner
      AND s.expires_at>clock_timestamp() AND s.consumed_at IS NULL
$$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_connection_secret_names(p_installation uuid,p_connection uuid)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(array_agg(s.name ORDER BY s.name),'{}'::text[]) FROM public.extension_secrets s
    WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND s.installation_id=p_installation AND s.connection_id=p_connection AND s.delete_after IS NULL
$$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_adopt_member_secret(p_pending uuid,p_installation uuid,p_registration uuid,p_connection uuid,p_owner text,p_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  staged public.extension_pending_secrets;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.extension_connections c JOIN public.extension_installations i ON i.id=c.installation_id AND i.workspace_id=c.workspace_id
    WHERE c.workspace_id=tenant AND c.installation_id=p_installation AND c.id=p_connection AND c.owner_id=p_owner
      AND c.state='connecting' AND i.registration_id=p_registration AND i.state='active') THEN RETURN false; END IF;
  SELECT * INTO staged FROM public.extension_pending_secrets s WHERE s.workspace_id=tenant AND s.id=p_pending
    AND s.draft_installation_id=p_installation AND s.registration_id=p_registration AND s.connection_id=p_connection
    AND s.owner_id=p_owner AND s.created_by->>'type'='user' AND s.created_by->>'id'=p_owner AND s.name=p_name
    AND s.consumed_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.extension_secrets(workspace_id,installation_id,connection_id,name,envelope)
    VALUES(tenant,p_installation,p_connection,p_name,staged.envelope)
    ON CONFLICT(workspace_id,installation_id,connection_id,name) DO UPDATE SET envelope=excluded.envelope,revision=extension_secrets.revision+1,delete_after=NULL;
  UPDATE public.extension_pending_secrets SET consumed_at=clock_timestamp() WHERE workspace_id=tenant AND id=p_pending;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_retire_member_secrets(p_installation uuid,p_connection uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.extension_connections c WHERE c.workspace_id=tenant AND c.installation_id=p_installation
    AND c.id=p_connection AND c.state='disconnected') THEN RETURN; END IF;
  UPDATE public.extension_secrets SET delete_after=clock_timestamp() WHERE workspace_id=tenant AND installation_id=p_installation AND connection_id=p_connection;
  DELETE FROM public.extension_pending_secrets WHERE workspace_id=tenant AND draft_installation_id=p_installation AND connection_id=p_connection;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_member_pending_secrets(uuid[],text),public.retainer_connection_secret_names(uuid,uuid),public.retainer_adopt_member_secret(uuid,uuid,uuid,uuid,text,text),public.retainer_retire_member_secrets(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_member_pending_secrets(uuid[],text),public.retainer_connection_secret_names(uuid,uuid),public.retainer_adopt_member_secret(uuid,uuid,uuid,uuid,text,text),public.retainer_retire_member_secrets(uuid,uuid) TO retainer_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_secret_names(installation uuid)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(array_agg(s.name ORDER BY s.name),'{}'::text[]) FROM public.extension_secrets s
    WHERE s.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
      AND s.installation_id=installation AND s.connection_id IS NULL AND s.delete_after IS NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_slot_available(candidate uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid; installation uuid;
BEGIN
  SELECT j.installation_id INTO installation FROM public.extension_jobs j WHERE j.id=candidate AND j.workspace_id=tenant;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(21063,0);
  RETURN (SELECT count(*) FROM public.extension_jobs j WHERE j.status='running' AND j.id<>candidate AND j.lease_until>clock_timestamp())<32
    AND (SELECT count(*) FROM public.extension_jobs j WHERE j.workspace_id=tenant AND j.status='running' AND j.id<>candidate AND j.lease_until>clock_timestamp())<4
    AND (SELECT count(*) FROM public.extension_jobs j WHERE j.workspace_id=tenant AND j.installation_id=installation AND j.status='running' AND j.id<>candidate AND j.lease_until>clock_timestamp())<4;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
RETURNS TABLE(workspace_id uuid,job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH candidates AS (
    SELECT DISTINCT ON(j.workspace_id,j.installation_id,j.connection_id)
      j.workspace_id,j.id,j.available_at,i.last_claimed_at as installation_claimed,c.last_claimed_at as connection_claimed
    FROM public.extension_jobs j
    JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
    JOIN public.workspaces w ON w.id=j.workspace_id AND (w.deletion_scheduled_at IS NULL OR j.trigger_kind IN ('uninstall','disconnect'))
    LEFT JOIN public.extension_connections c ON c.id=j.connection_id AND c.installation_id=j.installation_id AND c.workspace_id=j.workspace_id
    WHERE (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($2,$3))
      AND j.generation=i.generation AND j.release_digest=i.release_digest
      AND (
        (j.connection_id IS NULL AND (
          (i.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')))
        OR (j.connection_id IS NOT NULL AND j.connection_generation=c.generation AND (
          (i.state='active' AND c.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state='active' AND c.state='connecting' AND j.trigger_kind='connect')
          OR (c.state='disconnected' AND c.disconnected_at+interval '24 hours'>now() AND j.trigger_kind='disconnect')))
      )
      AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
        AND r.installation_id=j.installation_id AND r.connection_id IS NOT DISTINCT FROM j.connection_id
        AND r.status='running' AND r.lease_until>now() AND r.id<>j.id)
    ORDER BY j.workspace_id,j.installation_id,j.connection_id,
      CASE WHEN j.status='running' THEN 0 ELSE 1 END,j.available_at,j.id
  ) SELECT c.workspace_id,c.id FROM candidates c
    ORDER BY c.installation_claimed NULLS FIRST,c.connection_claimed NULLS FIRST,c.available_at,c.id
    LIMIT least(greatest(batch_limit,1),1000)
$$;
