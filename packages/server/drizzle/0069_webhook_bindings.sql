CREATE TABLE "webhook_bindings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"release_digest" text NOT NULL,
	"source_account_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"subscription_id" text,
	"route" text NOT NULL,
	"secret_name" text NOT NULL,
	"account_hint_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_bindings_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhook_bindings_state_ck" CHECK ("webhook_bindings"."state" in ('pending','active','retired')),
	CONSTRAINT "webhook_bindings_source_ck" CHECK ("webhook_bindings"."state"<>'active' or "webhook_bindings"."source_account_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "webhook_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"workspace_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"delivery_hash" text NOT NULL,
	"body_digest" text NOT NULL,
	"source_item_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_receipts_workspace_id_binding_id_delivery_hash_pk" PRIMARY KEY("workspace_id","binding_id","delivery_hash")
);
--> statement-breakpoint
ALTER TABLE "webhook_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_request_counts" (
	"workspace_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "webhook_request_counts_workspace_id_binding_id_pk" PRIMARY KEY("workspace_id","binding_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_request_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_bindings" ADD CONSTRAINT "webhook_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_bindings" ADD CONSTRAINT "webhook_bindings_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_bindings" ADD CONSTRAINT "webhook_bindings_account_fk" FOREIGN KEY ("workspace_id","source_account_id") REFERENCES "public"."source_accounts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_binding_fk" FOREIGN KEY ("workspace_id","binding_id") REFERENCES "public"."webhook_bindings"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_source_fk" FOREIGN KEY ("workspace_id","source_item_id") REFERENCES "public"."source_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."extension_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_request_counts" ADD CONSTRAINT "webhook_request_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_request_counts" ADD CONSTRAINT "webhook_counts_binding_fk" FOREIGN KEY ("workspace_id","binding_id") REFERENCES "public"."webhook_bindings"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_bindings_install_route_uq" ON "webhook_bindings" USING btree ("workspace_id","installation_id","route") WHERE "webhook_bindings"."state"<>'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_bindings_account_uq" ON "webhook_bindings" USING btree ("registration_id","route","account_hint_hash") WHERE "webhook_bindings"."state"='active' and "webhook_bindings"."account_hint_hash" is not null;--> statement-breakpoint
CREATE INDEX "webhook_bindings_install_idx" ON "webhook_bindings" USING btree ("workspace_id","installation_id");--> statement-breakpoint
CREATE INDEX "webhook_bindings_source_idx" ON "webhook_bindings" USING btree ("workspace_id","source_account_id");--> statement-breakpoint
CREATE INDEX "webhook_bindings_retention_idx" ON "webhook_bindings" USING btree ("updated_at","workspace_id") WHERE "webhook_bindings"."state"='retired';--> statement-breakpoint
CREATE INDEX "webhook_receipts_job_idx" ON "webhook_receipts" USING btree ("workspace_id","job_id");--> statement-breakpoint
CREATE INDEX "webhook_receipts_workspace_expiry_idx" ON "webhook_receipts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_receipts_expiry_idx" ON "webhook_receipts" USING btree ("created_at","workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_receipts_source_idx" ON "webhook_receipts" USING btree ("workspace_id","source_item_id");--> statement-breakpoint
CREATE POLICY "webhook_bindings_workspace" ON "webhook_bindings" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("webhook_bindings"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("webhook_bindings"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "webhook_receipts_workspace" ON "webhook_receipts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("webhook_receipts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("webhook_receipts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "webhook_counts_workspace" ON "webhook_request_counts" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("webhook_request_counts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("webhook_request_counts"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);