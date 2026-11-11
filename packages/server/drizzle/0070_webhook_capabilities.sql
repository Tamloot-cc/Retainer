GRANT SELECT,INSERT,UPDATE,DELETE ON webhook_bindings,webhook_receipts,webhook_request_counts TO retainer_app;
--> statement-breakpoint
-- At most one exact candidate: account hints route, but never authenticate, a delivery.
CREATE FUNCTION public.retainer_webhook_candidate(p_binding uuid,p_registration uuid,p_route text,p_hint text)
RETURNS TABLE(binding_id uuid,workspace_id uuid,installation_id uuid,registration_id uuid,generation integer,release_digest text,version text,source_account_id uuid,state text,binding_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT b.id,b.workspace_id,b.installation_id,b.registration_id,b.generation,b.release_digest,i.version,b.source_account_id,i.state,b.state
  FROM public.webhook_bindings b
  JOIN public.extension_installations i ON i.workspace_id=b.workspace_id AND i.id=b.installation_id AND i.registration_id=b.registration_id
    AND i.generation=b.generation AND i.release_digest=b.release_digest AND i.state IN ('active','installing','upgrading')
  LEFT JOIN public.source_bindings s ON s.workspace_id=b.workspace_id AND s.installation_id=b.installation_id
    AND s.account_id=b.source_account_id AND s.generation=b.generation
  JOIN public.workspaces w ON w.id=b.workspace_id AND w.deletion_scheduled_at IS NULL
  WHERE ((b.state='active' AND s.account_id IS NOT NULL) OR (b.state='pending' AND i.state IN ('installing','upgrading'))) AND b.route=p_route AND ((p_binding IS NOT NULL AND p_registration IS NULL AND p_hint IS NULL AND b.id=p_binding)
    OR (p_binding IS NULL AND p_registration IS NOT NULL AND p_hint IS NOT NULL AND b.registration_id=p_registration AND b.account_hint_hash=p_hint))
  LIMIT 2
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_webhook_candidate(uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_webhook_candidate(uuid,uuid,text,text) TO retainer_app;
--> statement-breakpoint
-- Only the broker can admit a candidate secret read. The lock remains held through decryption.
CREATE FUNCTION public.retainer_admit_webhook(p_binding uuid,p_generation integer,p_release text)
RETURNS TABLE(installation_id uuid,registration_id uuid,secret_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  registration uuid;
BEGIN
  IF tenant IS NULL THEN RETURN; END IF;
  SELECT b.registration_id INTO registration FROM public.webhook_bindings b WHERE b.workspace_id=tenant AND b.id=p_binding;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(21076::int4,hashtext(tenant::text));
  PERFORM pg_advisory_xact_lock_shared(21061::int4,hashtext(tenant::text||':'||registration::text));
  RETURN QUERY SELECT b.installation_id,b.registration_id,b.secret_name FROM public.webhook_bindings b
    JOIN public.extension_installations i ON i.workspace_id=b.workspace_id AND i.id=b.installation_id AND i.registration_id=b.registration_id
      AND i.generation=b.generation AND i.release_digest=b.release_digest AND i.state IN ('active','installing','upgrading')
    LEFT JOIN public.source_bindings s ON s.workspace_id=b.workspace_id AND s.installation_id=b.installation_id AND s.account_id=b.source_account_id AND s.generation=b.generation
    JOIN public.workspaces w ON w.id=b.workspace_id AND w.deletion_scheduled_at IS NULL
    WHERE b.workspace_id=tenant AND b.id=p_binding AND ((b.state='active' AND s.account_id IS NOT NULL) OR (b.state='pending' AND i.state IN ('installing','upgrading'))) AND b.generation=p_generation AND b.release_digest=p_release FOR SHARE OF b;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_admit_webhook(uuid,integer,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_admit_webhook(uuid,integer,text) TO retainer_secret_broker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retainer_change_retention_due(batch_limit integer)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT due.workspace_id FROM (
    SELECT c.workspace_id FROM public.change_counters c WHERE EXISTS(
      SELECT 1 FROM public.record_changes r WHERE r.workspace_id=c.workspace_id AND r.position>c.retained_after
      AND r.created_at<now()-interval '30 days' AND r.position<coalesce((
        SELECT min(fresh.position) FROM public.record_changes fresh WHERE fresh.workspace_id=c.workspace_id AND fresh.created_at>=now()-interval '30 days'
      ),c.position+1))
    UNION SELECT j.workspace_id FROM public.extension_jobs j WHERE j.status IN ('succeeded','failed','cancelled') AND j.updated_at<now()-interval '30 days'
    UNION SELECT j.workspace_id FROM public.extension_jobs j WHERE j.status IN ('queued','running') AND j.expires_at<=now()
      AND (j.status='queued' OR j.lease_until<=now())
    UNION SELECT r.workspace_id FROM public.webhook_receipts r WHERE r.created_at<now()-interval '7 days'
    UNION SELECT b.workspace_id FROM public.webhook_bindings b WHERE b.state='retired' AND b.updated_at<now()-interval '30 days'
  ) due ORDER BY due.workspace_id LIMIT least(greatest(batch_limit,1),1000)
$$;
