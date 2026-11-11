CREATE TABLE "extension_runtime_unavailable" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"runtime_identity" text NOT NULL,
	"generation" integer NOT NULL,
	"release_digest" text NOT NULL,
	"code" text NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_runtime_unavailable_workspace_id_installation_id_runtime_identity_pk" PRIMARY KEY("workspace_id","installation_id","runtime_identity"),
	CONSTRAINT "extension_runtime_unavailable_identity" CHECK ("extension_runtime_unavailable"."runtime_identity" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "extension_runtime_unavailable_generation" CHECK ("extension_runtime_unavailable"."generation" > 0),
	CONSTRAINT "extension_runtime_unavailable_code" CHECK ("extension_runtime_unavailable"."code" in ('incompatible_runtime', 'release_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "extension_runtime_unavailable" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_runtime_unavailable" ADD CONSTRAINT "extension_runtime_unavailable_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_runtime_unavailable" ADD CONSTRAINT "extension_runtime_unavailable_workspace_id_installation_id_extension_installations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_runtime_unavailable_checked_idx" ON "extension_runtime_unavailable" USING btree ("checked_at");--> statement-breakpoint
CREATE POLICY "extension_runtime_unavailable_workspace" ON "extension_runtime_unavailable" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_runtime_unavailable"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_runtime_unavailable"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);