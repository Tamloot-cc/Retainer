GRANT SELECT, INSERT, UPDATE, DELETE ON files, file_references, file_deletions TO retainer_app;
--> statement-breakpoint
-- Cascades must preserve an opaque, durable deletion obligation after a workspace is gone.
-- This function is trigger-only; no application or control role may invoke it directly.
CREATE FUNCTION public.retainer_queue_file_deletion() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  BEGIN
    INSERT INTO public.file_deletions(workspace_id,storage_id,object_key)
      VALUES(OLD.workspace_id,OLD.storage_id,OLD.object_key)
      ON CONFLICT(object_key) DO NOTHING;
    RETURN OLD;
  END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_queue_file_deletion() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER files_preserve_erasure BEFORE DELETE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.retainer_queue_file_deletion();
--> statement-breakpoint
-- Coordinator gets tenant IDs only, including obligations whose tenant no longer exists.
CREATE FUNCTION public.retainer_file_maintenance_due(storage text,batch_limit integer)
  RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    SELECT pending.workspace_id FROM (
      SELECT d.workspace_id FROM public.file_deletions d WHERE d.storage_id=storage
        AND ((d.status='queued' AND d.available_at<=now()) OR (d.status='running' AND d.lease_until<=now()))
      UNION
      SELECT f.workspace_id FROM public.files f WHERE f.storage_id=storage AND f.state IN ('pending','ready') AND f.expires_at<=now()
        AND NOT EXISTS(SELECT 1 FROM public.file_references ref WHERE ref.file_id=f.id AND ref.workspace_id=f.workspace_id)
    ) pending ORDER BY pending.workspace_id LIMIT least(greatest(batch_limit,1),1000)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_file_maintenance_due(text,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retainer_file_maintenance_due(text,integer) TO retainer_executor;
