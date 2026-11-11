CREATE TABLE "extension_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text,
	"prefix" text,
	"client_id" text,
	"subject_id" text,
	"scopes" jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "extension_credentials_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "extension_credentials_hash_uq" UNIQUE("key_hash"),
	CONSTRAINT "extension_credentials_kind" CHECK (("extension_credentials"."kind"='key' and "extension_credentials"."key_hash" is not null and "extension_credentials"."prefix" is not null and "extension_credentials"."client_id" is null and "extension_credentials"."subject_id" is null)
      or ("extension_credentials"."kind"='oauth' and "extension_credentials"."key_hash" is null and "extension_credentials"."prefix" is null and "extension_credentials"."client_id" is not null and "extension_credentials"."subject_id" is not null)),
	CONSTRAINT "extension_credentials_generation" CHECK ("extension_credentials"."generation">0),
	CONSTRAINT "extension_credentials_scopes" CHECK (jsonb_typeof("extension_credentials"."scopes")='array' and jsonb_array_length("extension_credentials"."scopes") between 1 and 2 and "extension_credentials"."scopes"<@'["read","write"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "extension_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_credentials" ADD CONSTRAINT "extension_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_credentials" ADD CONSTRAINT "extension_credentials_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_credentials_install_idx" ON "extension_credentials" USING btree ("workspace_id","installation_id");--> statement-breakpoint
CREATE POLICY "extension_credentials_workspace" ON "extension_credentials" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_credentials"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("extension_credentials"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);