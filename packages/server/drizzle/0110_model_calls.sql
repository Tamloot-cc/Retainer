CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"release_digest" text NOT NULL,
	"function_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"usage" jsonb NOT NULL,
	"provider_request_id" text,
	"partial" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_kind" CHECK ("ai_usage"."kind" in ('model', 'agent')),
	CONSTRAINT "ai_usage_tokens" CHECK ("ai_usage"."input_tokens" >= 0 and "ai_usage"."output_tokens" >= 0 and "ai_usage"."cache_read_tokens" >= 0 and "ai_usage"."cache_write_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_access_approvals" ADD COLUMN "uses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "granted_uses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_installation_idx" ON "ai_usage" USING btree ("workspace_id","installation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "ai_usage_workspace" ON "ai_usage" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("ai_usage"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("ai_usage"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);