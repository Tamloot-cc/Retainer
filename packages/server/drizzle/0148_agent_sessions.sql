CREATE TABLE "agent_days" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"subject" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_days_workspace_id_day_subject_pk" PRIMARY KEY("workspace_id","day","subject"),
	CONSTRAINT "agent_days_steps" CHECK ("agent_days"."steps" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner" text NOT NULL,
	"person_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"tools" jsonb NOT NULL,
	"extension_tools" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"system_blocks" jsonb NOT NULL,
	"last_date" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"limits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "agent_sessions_kind" CHECK ("agent_sessions"."kind" in ('chat', 'task')),
	CONSTRAINT "agent_sessions_status" CHECK ("agent_sessions"."status" in ('open'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_stream_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"access" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_stream_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"run_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"access" jsonb NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_build" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"web_fetches" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"duration_ms" integer,
	CONSTRAINT "agent_turns_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "agent_turns_generation_uq" UNIQUE("session_id","generation"),
	CONSTRAINT "agent_turns_status" CHECK ("agent_turns"."status" in ('running', 'completed', 'refused', 'incomplete', 'context_limit_reached', 'model_unavailable', 'history_rejected', 'limit_reached', 'cancelled', 'timed_out', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "agent_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_caller";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "agent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "agent_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "agent_step_id" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_days" ADD CONSTRAINT "agent_days_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_stream_tokens" ADD CONSTRAINT "agent_stream_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_stream_tokens" ADD CONSTRAINT "agent_stream_tokens_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."agent_sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."agent_sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_idx" ON "agent_sessions" USING btree ("workspace_id","owner","last_active_at");--> statement-breakpoint
CREATE INDEX "agent_stream_tokens_session_idx" ON "agent_stream_tokens" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "agent_stream_tokens_expiry_idx" ON "agent_stream_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_turns_workspace_idx" ON "agent_turns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_turns_run_idx" ON "agent_turns" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_turns_open_idx" ON "agent_turns" USING btree ("deadline") WHERE "agent_turns"."status" = 'running' or "agent_turns"."stopped_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_agent_step_uq" ON "ai_usage" USING btree ("agent_session_id","agent_step_id") WHERE "ai_usage"."kind" = 'agent';--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_caller" CHECK (("ai_usage"."kind" = 'routine' and "ai_usage"."routine_run_id" is not null) or ("ai_usage"."kind" = 'agent' and "ai_usage"."agent_session_id" is not null and "ai_usage"."agent_step_id" is not null) or ("ai_usage"."kind" = 'model' and "ai_usage"."installation_id" is not null and "ai_usage"."registration_id" is not null and "ai_usage"."release_digest" is not null and "ai_usage"."function_id" is not null and "ai_usage"."job_id" is not null));--> statement-breakpoint
CREATE POLICY "agent_days_workspace" ON "agent_days" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("agent_days"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("agent_days"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_sessions_workspace" ON "agent_sessions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("agent_sessions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("agent_sessions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_stream_tokens_workspace" ON "agent_stream_tokens" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("agent_stream_tokens"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("agent_stream_tokens"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_turns_workspace" ON "agent_turns" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("agent_turns"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("agent_turns"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);