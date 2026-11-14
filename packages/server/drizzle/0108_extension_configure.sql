CREATE TABLE "extension_access_approvals" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"release_digest" text NOT NULL,
	"generation" integer NOT NULL,
	"settings_revision" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"actor" text NOT NULL,
	"secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" jsonb NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_access_approvals_workspace_id_installation_id_release_digest_pk" PRIMARY KEY("workspace_id","installation_id","release_digest")
);
--> statement-breakpoint
ALTER TABLE "extension_access_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_suggestions" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"release_digest" text NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"mapping" jsonb,
	"settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_suggestions_workspace_id_installation_id_release_digest_pk" PRIMARY KEY("workspace_id","installation_id","release_digest")
);
--> statement-breakpoint
ALTER TABLE "extension_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_installations" DROP CONSTRAINT "extension_installations_state";--> statement-breakpoint
ALTER TABLE "extension_access_approvals" ADD CONSTRAINT "extension_access_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_access_approvals" ADD CONSTRAINT "extension_access_approvals_workspace_id_installation_id_extension_installations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_suggestions" ADD CONSTRAINT "extension_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_suggestions" ADD CONSTRAINT "extension_suggestions_workspace_id_installation_id_extension_installations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_state" CHECK ("extension_installations"."state" in ('configuring', 'installing', 'active', 'setup_failed', 'disabled', 'upgrading', 'uninstalling', 'uninstalled'));--> statement-breakpoint
CREATE POLICY "extension_access_approvals_workspace" ON "extension_access_approvals" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_access_approvals"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_access_approvals"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_suggestions_workspace" ON "extension_suggestions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_suggestions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_suggestions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);