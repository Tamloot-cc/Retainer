CREATE TABLE "extension_pending_secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"draft_installation_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"name" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now()+interval '15 minutes' NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extension_pending_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_secrets" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"delete_after" timestamp with time zone,
	CONSTRAINT "extension_secrets_workspace_id_installation_id_name_pk" PRIMARY KEY("workspace_id","installation_id","name")
);
--> statement-breakpoint
ALTER TABLE "extension_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_pending_secrets" ADD CONSTRAINT "extension_pending_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_secrets" ADD CONSTRAINT "extension_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_secrets" ADD CONSTRAINT "extension_secrets_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_pending_secrets_ws_expiry_idx" ON "extension_pending_secrets" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE POLICY "extension_pending_secrets_workspace" ON "extension_pending_secrets" AS PERMISSIVE FOR ALL TO "retainer_secret_broker" USING ("extension_pending_secrets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_pending_secrets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_secrets_workspace" ON "extension_secrets" AS PERMISSIVE FOR ALL TO "retainer_secret_broker" USING ("extension_secrets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_secrets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);