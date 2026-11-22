CREATE TABLE "extension_binding_proposals" (
	"workspace_id" uuid NOT NULL,
	"release_digest" text NOT NULL,
	"choices" jsonb NOT NULL,
	"proposed_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_binding_proposals_workspace_id_release_digest_pk" PRIMARY KEY("workspace_id","release_digest")
);
--> statement-breakpoint
ALTER TABLE "extension_binding_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_dispatch" ADD COLUMN "trigger_starts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "bindings" jsonb;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "bindings_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_suggestions" ADD COLUMN "bindings" jsonb;--> statement-breakpoint
ALTER TABLE "extension_suggestions" ADD COLUMN "binding_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "source_receipts" ADD COLUMN "projection" jsonb;--> statement-breakpoint
ALTER TABLE "extension_binding_proposals" ADD CONSTRAINT "extension_binding_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "extension_binding_proposals_workspace" ON "extension_binding_proposals" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_binding_proposals"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_binding_proposals"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);