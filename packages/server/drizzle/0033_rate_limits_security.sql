-- The per-workspace rate limit's counters (accounts spec 4.8). Applied by the
-- migration role, like 0001_security.
--
-- Unlogged: every API request updates its workspace's row, and the counts
-- are worth nothing after a crash, so they write no WAL. The API counts as
-- the runtime role, under the same workspace policy as tenant tables.
ALTER TABLE "workspace_request_counts" SET UNLOGGED;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "workspace_request_counts" TO retainer_app;
--> statement-breakpoint
ALTER TABLE "workspace_request_counts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "workspace_request_counts"
  USING ("workspace_id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("workspace_id" = "public"."retainer_current_workspace_id"());
