CREATE TABLE "agent_tasks" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"caller_kind" text NOT NULL,
	"routine_run_id" uuid,
	"routine_id" uuid,
	"position" integer,
	"extension_job_id" uuid,
	"installation_id" uuid,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"tool_groups" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"input" jsonb,
	"answer" jsonb,
	"code" text,
	"cause" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cause_depth" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"job_token_hash" text,
	"lease_until" timestamp with time zone,
	"repaired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_tasks_ws_session_uq" UNIQUE("workspace_id","session_id"),
	CONSTRAINT "agent_tasks_key_uq" UNIQUE("workspace_id","task_key"),
	CONSTRAINT "agent_tasks_caller_kind" CHECK ("agent_tasks"."caller_kind" in ('routine', 'extension')),
	CONSTRAINT "agent_tasks_caller" CHECK (("agent_tasks"."caller_kind" = 'routine' and "agent_tasks"."routine_run_id" is not null and "agent_tasks"."position" is not null) or ("agent_tasks"."caller_kind" = 'extension' and "agent_tasks"."extension_job_id" is not null and "agent_tasks"."installation_id" is not null)),
	CONSTRAINT "agent_tasks_mode" CHECK ("agent_tasks"."mode" in ('run', 'test', 'dry')),
	CONSTRAINT "agent_tasks_state" CHECK ("agent_tasks"."state" in ('staged', 'queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_jobs" DROP CONSTRAINT "extension_jobs_status";--> statement-breakpoint
ALTER TABLE "routine_runs" DROP CONSTRAINT "routine_runs_status";--> statement-breakpoint
DROP INDEX "routine_runs_record_idx";--> statement-breakpoint
DROP INDEX "routine_runs_one_running_uq";--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "agent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_run_results" ADD COLUMN "agent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_run_results" ADD COLUMN "delivered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."agent_sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_due_idx" ON "agent_tasks" USING btree ("available_at") WHERE "agent_tasks"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_tasks_run_idx" ON "agent_tasks" USING btree ("workspace_id","routine_run_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_job_idx" ON "agent_tasks" USING btree ("workspace_id","extension_job_id");--> statement-breakpoint
CREATE INDEX "routine_runs_waiting_idx" ON "routine_runs" USING btree ("expires_at") WHERE "routine_runs"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "routine_runs_record_idx" ON "routine_runs" USING btree ("routine_id","record_id") WHERE "routine_runs"."status" in ('queued', 'held', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_one_running_uq" ON "routine_runs" USING btree ("routine_id","record_id") WHERE "routine_runs"."status" in ('running', 'waiting') and "routine_runs"."mode" = 'run' and "routine_runs"."record_id" is not null;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_status" CHECK ("extension_jobs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_status" CHECK ("routine_runs"."status" in ('queued', 'held', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'expired', 'stopped', 'diverged', 'budget_exhausted', 'erased', 'discarded'));--> statement-breakpoint
CREATE POLICY "agent_tasks_workspace" ON "agent_tasks" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("agent_tasks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("agent_tasks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);