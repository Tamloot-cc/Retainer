CREATE TABLE "source_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"state" text DEFAULT 'synced' NOT NULL,
	"content_digest" text,
	"actor_name" text,
	CONSTRAINT "source_tasks_identity_uq" UNIQUE("workspace_id","account_id","external_id"),
	CONSTRAINT "source_tasks_state" CHECK ("source_tasks"."state" in ('synced','detached','local_deleted','removed'))
);
--> statement-breakpoint
ALTER TABLE "source_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "task_write_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."source_accounts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tasks" ADD CONSTRAINT "source_tasks_event_fk" FOREIGN KEY ("workspace_id","source_event_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_tasks_install_idx" ON "source_tasks" USING btree ("workspace_id","installation_id");--> statement-breakpoint
CREATE INDEX "source_tasks_item_idx" ON "source_tasks" USING btree ("workspace_id","item_id");--> statement-breakpoint
CREATE INDEX "source_tasks_record_idx" ON "source_tasks" USING btree ("workspace_id","record_id");--> statement-breakpoint
CREATE INDEX "source_tasks_event_idx" ON "source_tasks" USING btree ("workspace_id","source_event_id");--> statement-breakpoint
CREATE POLICY "source_tasks_workspace" ON "source_tasks" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_tasks"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_tasks"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);