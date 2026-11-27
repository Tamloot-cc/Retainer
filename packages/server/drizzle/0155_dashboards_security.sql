-- Drizzle models SET NULL but cannot specify the columns it applies to.
-- Keep the workspace of a dashboard when its source chat is deleted.
ALTER TABLE public.dashboards DROP CONSTRAINT dashboards_chat_fk;
--> statement-breakpoint
ALTER TABLE public.dashboards ADD CONSTRAINT dashboards_chat_fk
  FOREIGN KEY (workspace_id, chat_id) REFERENCES public.agent_sessions(workspace_id, id)
  ON DELETE SET NULL (chat_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboards TO retainer_app;
