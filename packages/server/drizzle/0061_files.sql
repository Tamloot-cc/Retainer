CREATE TABLE "file_deletions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_id" text DEFAULT 'local-v1' NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_deletions_object_key_uq" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "file_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "file_references" (
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	CONSTRAINT "file_references_workspace_id_file_id_assertion_id_pk" PRIMARY KEY("workspace_id","file_id","assertion_id")
);
--> statement-breakpoint
ALTER TABLE "file_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid,
	"storage_id" text DEFAULT 'local-v1' NOT NULL,
	"object_key" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_by" jsonb NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"upload_expires_at" timestamp with time zone DEFAULT clock_timestamp()+interval '5 minutes' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT clock_timestamp()+interval '24 hours' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "files_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "files_request_key_uq" UNIQUE("workspace_id","request_key"),
	CONSTRAINT "files_state" CHECK ("files"."state" in ('pending','ready','erasing','erased')),
	CONSTRAINT "files_bytes" CHECK ("files"."bytes">0 and "files"."bytes"<=26214400)
);
--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_assertion_fk" FOREIGN KEY ("workspace_id","assertion_id") REFERENCES "public"."field_assertions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_deletions_due_idx" ON "file_deletions" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "file_references_assertion_idx" ON "file_references" USING btree ("workspace_id","assertion_id");--> statement-breakpoint
CREATE INDEX "files_expiry_idx" ON "files" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "files_installation_idx" ON "files" USING btree ("workspace_id","installation_id");--> statement-breakpoint
CREATE POLICY "file_deletions_workspace" ON "file_deletions" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("file_deletions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("file_deletions"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "file_references_workspace" ON "file_references" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("file_references"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("file_references"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY "files_workspace" ON "files" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("files"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("files"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);