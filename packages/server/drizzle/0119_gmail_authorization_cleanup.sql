CREATE TABLE "gmail_authorization_cleanups" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_tag" text NOT NULL,
	"integration_id" text NOT NULL,
	"bound_connection_id" text,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"final_check_at" timestamp with time zone NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gmail_authorization_cleanups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "gmail_authorization_cleanups_due_idx" ON "gmail_authorization_cleanups" USING btree ("next_attempt_at","attempt_id");--> statement-breakpoint
CREATE POLICY "gmail_authorization_cleanups_workspace" ON "gmail_authorization_cleanups" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("gmail_authorization_cleanups"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("gmail_authorization_cleanups"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "gmail_authorization_cleanups_executor" ON "gmail_authorization_cleanups" AS PERMISSIVE FOR ALL TO "retainer_executor" USING (true) WITH CHECK (true);