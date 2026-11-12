CREATE TABLE "oauth_grant_references" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credential_id" uuid,
	CONSTRAINT "oauth_grant_references_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "oauth_grant_references_kind" CHECK (("oauth_grant_references"."kind"='person' and "oauth_grant_references"."id"="oauth_grant_references"."workspace_id" and "oauth_grant_references"."credential_id" is null)
      or ("oauth_grant_references"."kind"='installation' and "oauth_grant_references"."credential_id" is not null and "oauth_grant_references"."id"="oauth_grant_references"."credential_id"))
);
--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ADD CONSTRAINT "oauth_grant_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ADD CONSTRAINT "oauth_grant_references_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."extension_credentials"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_grant_references_credential_idx" ON "oauth_grant_references" USING btree ("workspace_id","credential_id");--> statement-breakpoint
CREATE POLICY "oauth_grant_references_installation" ON "oauth_grant_references" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("oauth_grant_references"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid and "oauth_grant_references"."kind"='installation') WITH CHECK ("oauth_grant_references"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid and "oauth_grant_references"."kind"='installation');