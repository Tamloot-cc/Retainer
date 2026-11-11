CREATE TABLE "extension_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"fence" bigint NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "extension_attempts_job_attempt_uq" UNIQUE("workspace_id","job_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "extension_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"release_digest" text NOT NULL,
	"function_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"cause" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"fence" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"cycle_attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_jobs_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "extension_jobs_dedupe_uq" UNIQUE("workspace_id","installation_id","generation","dedupe_key"),
	CONSTRAINT "extension_jobs_status" CHECK ("extension_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "extension_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_kv" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "extension_kv_workspace_id_installation_id_key_pk" PRIMARY KEY("workspace_id","installation_id","key"),
	CONSTRAINT "extension_kv_value_size" CHECK (octet_length("extension_kv"."value"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "extension_kv" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_installations" DROP CONSTRAINT "extension_installations_state";--> statement-breakpoint
ALTER TABLE "extension_attempts" ADD CONSTRAINT "extension_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_attempts" ADD CONSTRAINT "extension_attempts_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."extension_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_kv" ADD CONSTRAINT "extension_kv_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_kv" ADD CONSTRAINT "extension_kv_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_jobs_one_running_uq" ON "extension_jobs" USING btree ("workspace_id","installation_id") WHERE "extension_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "extension_jobs_due_idx" ON "extension_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "extension_jobs_install_idx" ON "extension_jobs" USING btree ("workspace_id","installation_id","created_at");--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_state" CHECK ("extension_installations"."state" in ('installing', 'active', 'setup_failed', 'disabled', 'upgrading', 'uninstalling', 'uninstalled'));--> statement-breakpoint
CREATE POLICY "extension_attempts_workspace" ON "extension_attempts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_attempts"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_attempts"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_jobs_workspace" ON "extension_jobs" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_jobs"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_jobs"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_kv_workspace" ON "extension_kv" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_kv"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_kv"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);