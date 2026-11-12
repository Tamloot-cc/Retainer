-- Broker-side admission holds revocation and lease locks through the secret read/write.
-- No API transaction may hold those locks while awaiting a second broker connection.
CREATE FUNCTION public.retainer_admit_secret_run(p_registration uuid,p_installation uuid,p_generation integer,p_job uuid,p_owner text,p_fence bigint,p_release text,p_writing boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  current_state text;
  cleanup_live boolean;
  job_trigger text;
BEGIN
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||p_registration::text));
  SELECT i.state,i.cleanup_deadline>clock_timestamp() INTO current_state,cleanup_live
    FROM public.extension_installations i JOIN public.workspaces w ON w.id=i.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE i.workspace_id=tenant AND i.id=p_installation AND i.registration_id=p_registration
      AND i.generation=p_generation AND i.release_digest=p_release;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT j.trigger_kind INTO job_trigger FROM public.extension_jobs j
    WHERE j.workspace_id=tenant AND j.id=p_job AND j.installation_id=p_installation AND j.generation=p_generation
      AND j.release_digest=p_release AND j.status='running' AND j.lease_owner=p_owner
      AND j.fence=p_fence AND j.lease_until>clock_timestamp() AND j.run_until>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN (job_trigger NOT IN ('install','uninstall') AND current_state='active')
    OR (job_trigger='install' AND current_state IN ('installing','upgrading'))
    OR (NOT p_writing AND job_trigger='uninstall' AND current_state='uninstalling' AND cleanup_live IS TRUE);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_admit_secret_run(uuid,uuid,integer,uuid,text,bigint,text,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_admit_secret_run(uuid,uuid,integer,uuid,text,bigint,text,boolean) TO retainer_secret_broker;
