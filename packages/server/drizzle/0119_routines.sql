CREATE TABLE "routine_firings" (
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_firings_routine_id_kind_record_id_due_at_pk" PRIMARY KEY("routine_id","kind","record_id","due_at"),
	CONSTRAINT "routine_firings_kind" CHECK ("routine_firings"."kind" in ('once', 'schedule'))
);
--> statement-breakpoint
ALTER TABLE "routine_firings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routine_model_days" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "routine_model_days_workspace_id_day_pk" PRIMARY KEY("workspace_id","day"),
	CONSTRAINT "routine_model_days_count" CHECK ("routine_model_days"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "routine_model_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routine_run_results" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"operation" text NOT NULL,
	"args_hash" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"code" text,
	"differs" boolean DEFAULT false NOT NULL,
	"tool_job_id" uuid,
	"record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_run_results_run_id_position_pk" PRIMARY KEY("run_id","position"),
	CONSTRAINT "routine_run_results_state" CHECK ("routine_run_results"."state" in ('started', 'done', 'failed', 'reported'))
);
--> statement-breakpoint
ALTER TABLE "routine_run_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid,
	"version_id" uuid,
	"source_id" uuid,
	"mode" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"record_id" uuid,
	"preview_id" uuid,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"code" text,
	"lease_owner" text,
	"fence" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"change_position" bigint,
	"cause" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cause_depth" integer DEFAULT 0 NOT NULL,
	"initiated_by" jsonb,
	"initiator_user_id" text,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_runs_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_runs_mode" CHECK ("routine_runs"."mode" in ('run', 'test', 'dry', 'check', 'build')),
	CONSTRAINT "routine_runs_status" CHECK ("routine_runs"."status" in ('queued', 'held', 'running', 'succeeded', 'failed', 'skipped', 'expired', 'stopped', 'diverged', 'budget_exhausted', 'erased', 'discarded')),
	CONSTRAINT "routine_runs_trigger_kind" CHECK ("routine_runs"."trigger_kind" in ('record', 'schedule', 'manual', 'test', 'preview', 'check', 'build')),
	CONSTRAINT "routine_runs_pinned" CHECK ("routine_runs"."mode" not in ('run', 'test') or ("routine_runs"."routine_id" is not null and "routine_runs"."source_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routine_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_sources_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_sources_hash_uq" UNIQUE("workspace_id","hash"),
	CONSTRAINT "routine_sources_hash" CHECK ("routine_sources"."hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "routine_sources_code_size" CHECK (octet_length("routine_sources"."code") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "routine_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routine_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"summary" text NOT NULL,
	"report" jsonb NOT NULL,
	"rank" text DEFAULT 'agent' NOT NULL,
	"types_fingerprint" text NOT NULL,
	"tool_contracts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"built_by" jsonb NOT NULL,
	"approved_by" jsonb,
	"approver_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_versions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_versions_number_uq" UNIQUE("routine_id","number"),
	CONSTRAINT "routine_versions_state" CHECK ("routine_versions"."state" in ('proposed', 'approved', 'superseded', 'rejected')),
	CONSTRAINT "routine_versions_rank" CHECK ("routine_versions"."rank" = 'agent')
);
--> statement-breakpoint
ALTER TABLE "routine_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"active_version_id" uuid,
	"feed_position" bigint,
	"next_fire_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routines_status" CHECK ("routines"."status" in ('draft', 'active', 'paused', 'needs_attention', 'archived')),
	CONSTRAINT "routines_name_length" CHECK (char_length("routines"."name") between 1 and 200),
	CONSTRAINT "routines_description_length" CHECK (char_length("routines"."description") between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_kind";--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "registration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "release_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "function_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "routine_run_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_firings" ADD CONSTRAINT "routine_firings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_firings" ADD CONSTRAINT "routine_firings_routine_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_model_days" ADD CONSTRAINT "routine_model_days_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_results" ADD CONSTRAINT "routine_run_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_results" ADD CONSTRAINT "routine_run_results_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."routine_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."routine_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."routine_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_sources" ADD CONSTRAINT "routine_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_routine_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."routine_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_firings_record_idx" ON "routine_firings" USING btree ("workspace_id","record_id");--> statement-breakpoint
CREATE INDEX "routine_run_results_workspace_idx" ON "routine_run_results" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "routine_runs_routine_idx" ON "routine_runs" USING btree ("workspace_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_runs_due_idx" ON "routine_runs" USING btree ("available_at") WHERE "routine_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "routine_runs_record_idx" ON "routine_runs" USING btree ("routine_id","record_id") WHERE "routine_runs"."status" in ('queued', 'held', 'running');--> statement-breakpoint
CREATE INDEX "routine_runs_preview_idx" ON "routine_runs" USING btree ("workspace_id","preview_id");--> statement-breakpoint
CREATE INDEX "routine_runs_version_idx" ON "routine_runs" USING btree ("workspace_id","version_id");--> statement-breakpoint
CREATE INDEX "routine_runs_source_idx" ON "routine_runs" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE INDEX "routine_runs_retention_idx" ON "routine_runs" USING btree ("finished_at") WHERE "routine_runs"."finished_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_one_running_uq" ON "routine_runs" USING btree ("routine_id","record_id") WHERE "routine_runs"."status" = 'running' and "routine_runs"."mode" = 'run' and "routine_runs"."record_id" is not null;--> statement-breakpoint
CREATE INDEX "routine_versions_source_idx" ON "routine_versions" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE INDEX "routines_status_idx" ON "routines" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "routines_schedule_idx" ON "routines" USING btree ("next_fire_at") WHERE "routines"."status" = 'active' and "routines"."next_fire_at" is not null;--> statement-breakpoint
CREATE INDEX "ai_usage_routine_idx" ON "ai_usage" USING btree ("workspace_id","routine_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_caller" CHECK (("ai_usage"."kind" = 'routine' and "ai_usage"."routine_run_id" is not null) or ("ai_usage"."kind" <> 'routine' and "ai_usage"."installation_id" is not null and "ai_usage"."registration_id" is not null and "ai_usage"."release_digest" is not null and "ai_usage"."function_id" is not null and "ai_usage"."job_id" is not null));--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_kind" CHECK ("ai_usage"."kind" in ('model', 'agent', 'routine'));--> statement-breakpoint
CREATE POLICY "routine_firings_workspace" ON "routine_firings" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_firings"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_firings"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routine_model_days_workspace" ON "routine_model_days" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_model_days"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_model_days"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routine_run_results_workspace" ON "routine_run_results" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_run_results"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_run_results"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routine_runs_workspace" ON "routine_runs" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_runs"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_runs"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routine_sources_workspace" ON "routine_sources" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_sources"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_sources"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routine_versions_workspace" ON "routine_versions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routine_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routine_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "routines_workspace" ON "routines" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("routines"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("routines"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);