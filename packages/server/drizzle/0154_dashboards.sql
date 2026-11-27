CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"program" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"chat_id" uuid,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_visibility" CHECK ("dashboards"."visibility" in ('workspace', 'private'))
);
--> statement-breakpoint
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_chat_fk" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "public"."agent_sessions"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_workspace_position_idx" ON "dashboards" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "dashboards_chat_idx" ON "dashboards" USING btree ("chat_id");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_client" CHECK (("agent_sessions"."client" is null or ("agent_sessions"."kind" = 'chat' and "agent_sessions"."client" in ('web', 'cli')) or ("agent_sessions"."kind" = 'task' and "agent_sessions"."client" = 'task')));--> statement-breakpoint
CREATE POLICY "dashboards_workspace" ON "dashboards" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("dashboards"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("dashboards"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);