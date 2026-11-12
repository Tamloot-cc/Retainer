CREATE TABLE "source_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"namespace" text NOT NULL,
	"identity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_accounts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_accounts_identity_uq" UNIQUE("workspace_id","registration_id","provider","namespace")
);
--> statement-breakpoint
ALTER TABLE "source_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_bindings" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_bindings_workspace_id_installation_id_pk" PRIMARY KEY("workspace_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "source_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"provider_revision" text,
	"prepared_job_id" uuid,
	"prepared_fence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_items_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_items_identity_uq" UNIQUE("workspace_id","account_id","external_id"),
	CONSTRAINT "source_items_state" CHECK ("source_items"."state" in ('reserved','live','unavailable','deleted','retracted','erased')),
	CONSTRAINT "source_items_erased_identity" CHECK (("source_items"."state"='erased')=("source_items"."external_id" is null))
);
--> statement-breakpoint
ALTER TABLE "source_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_participants" (
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "source_participants_workspace_id_item_id_email_pk" PRIMARY KEY("workspace_id","item_id","email")
);
--> statement-breakpoint
ALTER TABLE "source_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_receipts" (
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content_digest" text NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "source_receipts_workspace_id_item_id_key_pk" PRIMARY KEY("workspace_id","item_id","key")
);
--> statement-breakpoint
ALTER TABLE "source_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"content_digest" text NOT NULL,
	"provider_revision" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"previous_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revisions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_revisions_event_uq" UNIQUE("workspace_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "source_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "source_accounts" ADD CONSTRAINT "source_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."source_accounts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."source_accounts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_participants" ADD CONSTRAINT "source_participants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_participants" ADD CONSTRAINT "source_participants_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_receipts" ADD CONSTRAINT "source_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_receipts" ADD CONSTRAINT "source_receipts_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_bindings_account_idx" ON "source_bindings" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "source_participants_email_idx" ON "source_participants" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_current_uq" ON "source_revisions" USING btree ("workspace_id","item_id") WHERE "source_revisions"."is_current";--> statement-breakpoint
CREATE INDEX "source_revisions_item_idx" ON "source_revisions" USING btree ("workspace_id","item_id");--> statement-breakpoint
CREATE INDEX "source_revisions_previous_idx" ON "source_revisions" USING btree ("workspace_id","previous_event_id");--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD CONSTRAINT "extension_jobs_source_fk" FOREIGN KEY ("workspace_id","source_item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_source_fk" FOREIGN KEY ("workspace_id","source_item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_jobs_source_idx" ON "extension_jobs" USING btree ("workspace_id","source_item_id");--> statement-breakpoint
CREATE INDEX "files_source_idx" ON "files" USING btree ("workspace_id","source_item_id");--> statement-breakpoint
CREATE POLICY "source_accounts_workspace" ON "source_accounts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_accounts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_accounts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "source_bindings_workspace" ON "source_bindings" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_bindings"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_bindings"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "source_items_workspace" ON "source_items" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_items"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_items"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "source_participants_workspace" ON "source_participants" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_participants"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_participants"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "source_receipts_workspace" ON "source_receipts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_receipts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_receipts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "source_revisions_workspace" ON "source_revisions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_revisions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_revisions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);