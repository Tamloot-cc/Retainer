-- Cross-workspace coordination receives identifiers only, never change bodies or credentials.
CREATE FUNCTION public.retainer_extension_changes_due(after_id uuid,batch_limit integer)
RETURNS TABLE(workspace_id uuid,installation_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT d.workspace_id,d.installation_id FROM public.change_dispatch d
  JOIN public.extension_installations i ON i.id=d.installation_id AND i.workspace_id=d.workspace_id AND i.generation=d.generation AND i.state='active'
  JOIN public.change_counters c ON c.workspace_id=d.workspace_id AND c.position>d.position
  ORDER BY CASE WHEN after_id IS NULL OR d.installation_id>after_id THEN 0 ELSE 1 END,d.installation_id
  LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_extension_changes_due(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_extension_changes_due(uuid,integer) TO retainer_executor;
--> statement-breakpoint
CREATE FUNCTION public.retainer_change_retention_due(batch_limit integer)
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
  ) due ORDER BY due.workspace_id LIMIT least(greatest(batch_limit,1),1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_change_retention_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_change_retention_due(integer) TO retainer_executor;
