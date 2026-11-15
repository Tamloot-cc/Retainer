CREATE TABLE "extension_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_ref" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconnect" boolean DEFAULT false NOT NULL,
	"expected_generation" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "extension_authorizations_state_hash" CHECK ("extension_authorizations"."state_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "extension_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "disconnect_secrets" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "credential" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "authorization_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "release_incomplete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "release_notice_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_connections" ADD COLUMN "release_incidents" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_authorizations" ADD CONSTRAINT "extension_authorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_authorizations" ADD CONSTRAINT "extension_authorizations_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_authorizations_state_uq" ON "extension_authorizations" USING btree ("workspace_id","state_hash");--> statement-breakpoint
CREATE INDEX "extension_authorizations_connection_idx" ON "extension_authorizations" USING btree ("workspace_id","connection_id");--> statement-breakpoint
CREATE INDEX "extension_authorizations_owner_idx" ON "extension_authorizations" USING btree ("workspace_id","installation_id","owner_id");--> statement-breakpoint
ALTER TABLE "extension_connections" ADD CONSTRAINT "extension_connections_credential" CHECK ("extension_connections"."credential" in ('key','oauth'));--> statement-breakpoint
ALTER TABLE "extension_connections" ADD CONSTRAINT "extension_connections_release_incidents" CHECK (cardinality("extension_connections"."release_incidents")<=32);--> statement-breakpoint
CREATE POLICY "extension_authorizations_workspace" ON "extension_authorizations" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_authorizations"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("extension_authorizations"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);