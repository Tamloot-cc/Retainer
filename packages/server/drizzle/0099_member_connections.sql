CREATE TABLE "extension_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"owner" jsonb NOT NULL,
	"owner_id" text NOT NULL,
	"state" text DEFAULT 'connecting' NOT NULL,
	"health" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings_revision" integer DEFAULT 1 NOT NULL,
	"source_account_id" uuid,
	"last_claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "extension_connections_scope_uq" UNIQUE("workspace_id","installation_id","id"),
	CONSTRAINT "extension_connections_owner" CHECK (coalesce("extension_connections"."owner"->>'type'='user' and "extension_connections"."owner"->>'id'="extension_connections"."owner_id" and length("extension_connections"."owner_id")>0,false)),
	CONSTRAINT "extension_connections_state" CHECK ("extension_connections"."state" in ('connecting','active','setup_failed','needs_reconnect','disconnected')),
	CONSTRAINT "extension_connections_health" CHECK ("extension_connections"."health" in ('ok','needs_reconnect','degraded')),
	CONSTRAINT "extension_connections_versions" CHECK ("extension_connections"."generation">0 and "extension_connections"."settings_revision">0)
);
--> statement-breakpoint
ALTER TABLE "extension_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_jobs" DROP CONSTRAINT "extension_jobs_dedupe_uq";--> statement-breakpoint
DROP INDEX "extension_jobs_one_running_uq";--> statement-breakpoint
ALTER TABLE "extension_kv" DROP CONSTRAINT "extension_kv_workspace_id_installation_id_key_pk";--> statement-breakpoint
ALTER TABLE "extension_schedules" DROP CONSTRAINT "extension_schedules_workspace_id_installation_id_function_id_pk";--> statement-breakpoint
ALTER TABLE "extension_secrets" DROP CONSTRAINT "extension_secrets_workspace_id_installation_id_name_pk";--> statement-breakpoint
ALTER TABLE "extension_write_budgets" DROP CONSTRAINT "extension_write_budgets_workspace_id_installation_id_pk";--> statement-breakpoint
ALTER TABLE "source_bindings" DROP CONSTRAINT "source_bindings_workspace_id_installation_id_pk";--> statement-breakpoint
ALTER TABLE "source_sync_state" DROP CONSTRAINT "source_sync_state_workspace_id_installation_id_pk";--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "last_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "connection_generation" integer;--> statement-breakpoint
ALTER TABLE "extension_kv" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_pending_secrets" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_pending_secrets" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "extension_schedules" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_secrets" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD CONSTRAINT "extension_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD CONSTRAINT "extension_connections_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD CONSTRAINT "extension_connections_account_fk" FOREIGN KEY ("workspace_id","source_account_id") REFERENCES "public"."source_accounts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_connections_owner_uq" ON "extension_connections" USING btree ("workspace_id","installation_id","owner_id") WHERE "extension_connections"."state"<>'disconnected';--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_kv" ADD CONSTRAINT "extension_kv_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_schedules" ADD CONSTRAINT "extension_schedules_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_secrets" ADD CONSTRAINT "extension_secrets_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ADD CONSTRAINT "extension_write_budgets_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_state_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_jobs_one_running_connection_uq" ON "extension_jobs" USING btree ("workspace_id","installation_id","connection_id") WHERE "extension_jobs"."status" = 'running' and "extension_jobs"."connection_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_jobs_one_running_uq" ON "extension_jobs" USING btree ("workspace_id","installation_id") WHERE "extension_jobs"."status" = 'running' and "extension_jobs"."connection_id" is null;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_dedupe_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id","connection_generation","generation","dedupe_key");--> statement-breakpoint
ALTER TABLE "extension_kv" ADD CONSTRAINT "extension_kv_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id","key");--> statement-breakpoint
ALTER TABLE "extension_schedules" ADD CONSTRAINT "extension_schedules_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id","function_id");--> statement-breakpoint
ALTER TABLE "extension_secrets" ADD CONSTRAINT "extension_secrets_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id","name");--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ADD CONSTRAINT "extension_write_budgets_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id");--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_account_scope_uq" UNIQUE("workspace_id","installation_id","account_id");--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id");--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_state_scope_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","installation_id","connection_id");--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_connection_generation" CHECK (("extension_jobs"."connection_id" is null and "extension_jobs"."connection_generation" is null) or ("extension_jobs"."connection_id" is not null and "extension_jobs"."connection_generation" is not null and "extension_jobs"."connection_generation">0));--> statement-breakpoint
CREATE POLICY "extension_connections_workspace" ON "extension_connections" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_connections"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("extension_connections"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);