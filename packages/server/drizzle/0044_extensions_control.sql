CREATE TABLE "extension_contributions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"universal_id" uuid NOT NULL,
	"element_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "extension_contributions_owner_uq" UNIQUE("workspace_id","kind","universal_id")
);
--> statement-breakpoint
ALTER TABLE "extension_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_installations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"version" text NOT NULL,
	"release_digest" text NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"granted_actor" text NOT NULL,
	"granted_scopes" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings_revision" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_installations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "extension_installations_registration_uq" UNIQUE("workspace_id","registration_id"),
	CONSTRAINT "extension_installations_state" CHECK ("extension_installations"."state" in ('disabled', 'uninstalled')),
	CONSTRAINT "extension_installations_actor" CHECK ("extension_installations"."granted_actor" in ('agent', 'integration')),
	CONSTRAINT "extension_installations_generation" CHECK ("extension_installations"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "extension_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_receipts_key_uq" UNIQUE("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "extension_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_contributions" ADD CONSTRAINT "extension_contributions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_contributions" ADD CONSTRAINT "extension_contributions_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_receipts" ADD CONSTRAINT "extension_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_receipts" ADD CONSTRAINT "extension_receipts_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "extension_contributions_workspace" ON "extension_contributions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_contributions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_contributions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_installations_workspace" ON "extension_installations" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_installations"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_installations"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_receipts_workspace" ON "extension_receipts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_receipts"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_receipts"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);