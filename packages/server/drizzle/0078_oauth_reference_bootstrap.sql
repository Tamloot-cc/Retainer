GRANT SELECT,INSERT,UPDATE,DELETE ON oauth_grant_references TO retainer_app;
--> statement-breakpoint
-- The trigger is installed before backfill, so workspace inserts cannot fall between them.
CREATE FUNCTION retainer_bootstrap_oauth_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.oauth_grant_references(id,workspace_id,kind) VALUES(NEW.id,NEW.id,'person');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_bootstrap_oauth_reference() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER oauth_workspace_reference AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION public.retainer_bootstrap_oauth_reference();
--> statement-breakpoint
INSERT INTO public.oauth_grant_references(id,workspace_id,kind) SELECT id,id,'person' FROM public.workspaces;
