CREATE TABLE "cli_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"login_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"organization_id" uuid,
	"action" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"result_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_approvals_kind" CHECK ("cli_approvals"."kind" in ('elevation', 'action')),
	CONSTRAINT "cli_approvals_status" CHECK ("cli_approvals"."status" in ('pending', 'approved', 'denied', 'used', 'ended', 'expired')),
	CONSTRAINT "cli_approvals_target" CHECK (num_nonnulls("cli_approvals"."workspace_id", "cli_approvals"."organization_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "cli_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cli_logins" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"machine_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cli_logins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "passkey_change_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credential_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "passkey_change_authorizations_target_uq" UNIQUE("user_id","kind","credential_id"),
	CONSTRAINT "passkey_change_authorizations_kind" CHECK ("passkey_change_authorizations"."kind" in ('insert', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "passkey_change_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_grant_references" DROP CONSTRAINT "oauth_grant_references_kind";--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ADD COLUMN "cli_login_id" uuid;--> statement-breakpoint
ALTER TABLE "cli_approvals" ADD CONSTRAINT "cli_approvals_login_id_cli_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."cli_logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_approvals" ADD CONSTRAINT "cli_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_approvals" ADD CONSTRAINT "cli_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_approvals" ADD CONSTRAINT "cli_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_change_authorizations" ADD CONSTRAINT "passkey_change_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_approvals_login_idx" ON "cli_approvals" USING btree ("login_id");--> statement-breakpoint
CREATE INDEX "cli_approvals_workspace_idx" ON "cli_approvals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cli_approvals_organization_idx" ON "cli_approvals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cli_logins_user_idx" ON "cli_logins" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ADD CONSTRAINT "oauth_grant_references_cli_login_id_cli_logins_id_fk" FOREIGN KEY ("cli_login_id") REFERENCES "public"."cli_logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_references" ADD CONSTRAINT "oauth_grant_references_kind" CHECK (("oauth_grant_references"."kind"='person' and "oauth_grant_references"."workspace_id" is not null and "oauth_grant_references"."id"="oauth_grant_references"."workspace_id" and "oauth_grant_references"."credential_id" is null and "oauth_grant_references"."cli_login_id" is null)
      or ("oauth_grant_references"."kind"='installation' and "oauth_grant_references"."workspace_id" is not null and "oauth_grant_references"."credential_id" is not null and "oauth_grant_references"."id"="oauth_grant_references"."credential_id" and "oauth_grant_references"."cli_login_id" is null)
      or ("oauth_grant_references"."kind"='cli' and "oauth_grant_references"."workspace_id" is null and "oauth_grant_references"."credential_id" is null and "oauth_grant_references"."cli_login_id" is not null and "oauth_grant_references"."id"="oauth_grant_references"."cli_login_id"));