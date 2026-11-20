CREATE TABLE "gmail_contact_additions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"history_days" integer NOT NULL,
	CONSTRAINT "gmail_contact_additions_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "gmail_contact_additions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gmail_contact_scans" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"addition_id" uuid NOT NULL,
	CONSTRAINT "gmail_contact_scans_workspace_id_connection_id_addition_id_pk" PRIMARY KEY("workspace_id","connection_id","addition_id")
);
--> statement-breakpoint
ALTER TABLE "gmail_contact_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gmail_deliveries" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	CONSTRAINT "gmail_deliveries_pk" PRIMARY KEY("workspace_id","connection_id","provider_message_id")
);
--> statement-breakpoint
ALTER TABLE "gmail_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gmail_messages" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_group_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"original_date" timestamp with time zone,
	"body" text NOT NULL,
	CONSTRAINT "gmail_messages_ws_id_uq" UNIQUE("workspace_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "gmail_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_authorizations" ALTER COLUMN "verifier_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_contact_additions" ADD CONSTRAINT "gmail_contact_additions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_contact_additions" ADD CONSTRAINT "gmail_contact_additions_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_contact_scans" ADD CONSTRAINT "gmail_contact_scans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_contact_scans" ADD CONSTRAINT "gmail_contact_scans_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_contact_scans" ADD CONSTRAINT "gmail_contact_scans_addition_fk" FOREIGN KEY ("workspace_id","addition_id") REFERENCES "public"."gmail_contact_additions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_deliveries" ADD CONSTRAINT "gmail_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_deliveries" ADD CONSTRAINT "gmail_deliveries_connection_fk" FOREIGN KEY ("workspace_id","installation_id","connection_id") REFERENCES "public"."extension_connections"("workspace_id","installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_deliveries" ADD CONSTRAINT "gmail_deliveries_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."gmail_messages"("workspace_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gmail_contact_additions_at_idx" ON "gmail_contact_additions" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "gmail_contact_additions_record_idx" ON "gmail_contact_additions" USING btree ("workspace_id","record_id");--> statement-breakpoint
CREATE INDEX "gmail_contact_scans_connection_idx" ON "gmail_contact_scans" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "gmail_contact_scans_addition_idx" ON "gmail_contact_scans" USING btree ("workspace_id","addition_id");--> statement-breakpoint
CREATE INDEX "gmail_deliveries_connection_idx" ON "gmail_deliveries" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "gmail_deliveries_thread_idx" ON "gmail_deliveries" USING btree ("workspace_id","connection_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "gmail_deliveries_message_idx" ON "gmail_deliveries" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "gmail_messages_thread_idx" ON "gmail_messages" USING btree ("workspace_id","thread_group_id","occurred_at","event_id");--> statement-breakpoint
CREATE POLICY "gmail_contact_additions_workspace" ON "gmail_contact_additions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("gmail_contact_additions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("gmail_contact_additions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "gmail_contact_scans_workspace" ON "gmail_contact_scans" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("gmail_contact_scans"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("gmail_contact_scans"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "gmail_deliveries_workspace" ON "gmail_deliveries" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("gmail_deliveries"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("gmail_deliveries"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "gmail_messages_workspace" ON "gmail_messages" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("gmail_messages"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("gmail_messages"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);