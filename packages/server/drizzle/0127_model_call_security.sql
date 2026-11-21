GRANT SELECT, INSERT, UPDATE ON public.model_calls TO retainer_app;
--> statement-breakpoint
-- The executor can remove only a bounded batch of expired metadata.
CREATE FUNCTION public.retainer_prune_model_calls() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH due AS (
    SELECT workspace_id, id FROM public.model_calls
    WHERE started_at < now() - interval '30 days'
    ORDER BY started_at LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.model_calls c USING due
    WHERE c.workspace_id=due.workspace_id AND c.id=due.id
    RETURNING 1
  )
  SELECT count(*)::integer FROM removed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_prune_model_calls() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_prune_model_calls() TO retainer_executor;
--> statement-breakpoint
GRANT INSERT ON public.model_call_payloads TO retainer_app;
--> statement-breakpoint
CREATE FUNCTION public.retainer_prune_model_call_payloads() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH due AS (
    SELECT workspace_id, call_id FROM public.model_call_payloads
    WHERE expires_at <= now()
    ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.model_call_payloads p USING due
    WHERE p.workspace_id=due.workspace_id AND p.call_id=due.call_id
    RETURNING 1
  )
  SELECT count(*)::integer FROM removed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_prune_model_call_payloads() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_prune_model_call_payloads() TO retainer_executor;
