CREATE TABLE "change_counters" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"retained_after" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "change_dispatch" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"blocked_cycles" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "change_dispatch_workspace_id_installation_id_pk" PRIMARY KEY("workspace_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "change_dispatch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_changes" (
	"workspace_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"record_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"field_keys" jsonb NOT NULL,
	"related_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin_installation_id" uuid,
	"cause" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "record_changes_workspace_id_position_pk" PRIMARY KEY("workspace_id","position"),
	CONSTRAINT "record_changes_operation" CHECK ("record_changes"."operation" in ('create','update','links','delete','merge','retract','supersede','review','forget'))
);
--> statement-breakpoint
ALTER TABLE "record_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "change_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "change_counters" ADD CONSTRAINT "change_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_dispatch" ADD CONSTRAINT "change_dispatch_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_dispatch" ADD CONSTRAINT "change_dispatch_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_changes" ADD CONSTRAINT "record_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_changes_record_idx" ON "record_changes" USING btree ("workspace_id","record_id");--> statement-breakpoint
CREATE INDEX "record_changes_retention_idx" ON "record_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "extension_jobs_retention_idx" ON "extension_jobs" USING btree ("updated_at","workspace_id") WHERE "extension_jobs"."status" in ('succeeded','failed','cancelled');--> statement-breakpoint
CREATE INDEX "extension_jobs_expiry_idx" ON "extension_jobs" USING btree ("expires_at","workspace_id") WHERE "extension_jobs"."status" in ('queued','running');--> statement-breakpoint
CREATE POLICY "change_counters_workspace" ON "change_counters" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("change_counters"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("change_counters"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "change_dispatch_workspace" ON "change_dispatch" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("change_dispatch"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("change_dispatch"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "record_changes_workspace" ON "record_changes" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("record_changes"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("record_changes"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);