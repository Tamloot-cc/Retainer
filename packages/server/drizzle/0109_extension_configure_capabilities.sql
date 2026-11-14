-- Configure runs use the ordinary run machinery, including broker-local admission.
GRANT SELECT,INSERT,UPDATE,DELETE ON extension_suggestions,extension_access_approvals TO retainer_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_adopt_extension_secret(pending uuid, installation uuid, registration uuid, key_name text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  staged public.extension_pending_secrets;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant
      AND i.id=installation AND i.registration_id=registration AND i.state IN ('configuring','disabled','installing','upgrading')) THEN RETURN false; END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_function uuid,p_name text,p_writing boolean,p_connection uuid DEFAULT NULL,p_connection_generation integer DEFAULT NULL)
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
      AND i.generation=p_generation;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind INTO job_trigger FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.connection_id IS NOT DISTINCT FROM p_connection AND j.connection_generation IS NOT DISTINCT FROM p_connection_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp()
      AND j.function_id=p_function AND p_name=ANY(j.run_secrets) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF job_trigger='configure' THEN
    RETURN NOT p_writing AND p_connection IS NULL AND NOT deleting AND current_state IN ('configuring','active')
      AND EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant AND i.id=p_installation
        AND (i.release_digest=p_release OR EXISTS(SELECT 1 FROM public.extension_access_approvals a
          WHERE a.workspace_id=tenant AND a.installation_id=p_installation AND a.release_digest=p_release
          AND a.generation=i.generation AND a.settings_revision=i.settings_revision)));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.workspace_id=tenant AND i.id=p_installation AND i.release_digest=p_release) THEN RETURN false; END IF;
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
    WHERE (i.registration_id,j.release_digest) IN (SELECT * FROM unnest($2,$3))
      AND j.generation=i.generation AND (j.release_digest=i.release_digest OR
        (j.trigger_kind='configure' AND i.state='active' AND EXISTS(SELECT 1 FROM public.extension_access_approvals a
          WHERE a.workspace_id=j.workspace_id AND a.installation_id=i.id AND a.release_digest=j.release_digest
          AND a.generation=i.generation AND a.settings_revision=i.settings_revision)))
      AND (
        (j.connection_id IS NULL AND (
          (i.state='configuring' AND j.trigger_kind='configure')
          OR (i.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_extension_maintenance_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
  RETURNS TABLE(workspace_id uuid, installation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT i.workspace_id,i.id FROM public.extension_installations i
    JOIN public.workspaces w ON w.id=i.workspace_id AND (w.deletion_scheduled_at IS NULL OR i.state='uninstalling')
    WHERE (i.state='configuring' AND i.created_at<=now()-interval '14 days')
      OR (i.state='uninstalling' AND i.cleanup_deadline<=now())
      OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND NOT EXISTS(SELECT 1 FROM public.extension_jobs j
          WHERE j.workspace_id=i.workspace_id AND j.installation_id=i.id AND j.generation=i.generation AND j.trigger_kind='uninstall'))
      OR (i.state='active' AND (i.registration_id,i.release_digest) IN (SELECT * FROM unnest($2,$3))
        AND (NOT EXISTS(SELECT 1 FROM public.extension_schedules s
        WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id)
        OR EXISTS(SELECT 1 FROM public.extension_schedules s WHERE s.workspace_id=i.workspace_id AND s.installation_id=i.id AND s.next_due_at<=now())))
    ORDER BY i.updated_at,i.id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
CREATE FUNCTION public.retainer_configure_secret_reference(p_job uuid,p_name text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT (a.secret_refs->>p_name)::uuid FROM public.extension_jobs j
  JOIN public.extension_access_approvals a ON a.workspace_id=j.workspace_id AND a.installation_id=j.installation_id AND a.release_digest=j.release_digest
  JOIN public.extension_installations i ON i.workspace_id=j.workspace_id AND i.id=j.installation_id
  WHERE j.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND j.id=p_job
    AND j.trigger_kind='configure' AND j.status='running' AND a.generation=i.generation AND a.settings_revision=i.settings_revision
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_configure_secret_reference(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_configure_secret_reference(uuid,text) TO retainer_secret_broker;
