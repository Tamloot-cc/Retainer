ALTER TABLE "oauth_access_tokens" DROP CONSTRAINT "oauth_access_tokens_reference_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_consents" DROP CONSTRAINT "oauth_consents_reference_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" DROP CONSTRAINT "oauth_refresh_tokens_reference_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_reference_id_oauth_grant_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."oauth_grant_references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_reference_id_oauth_grant_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."oauth_grant_references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_reference_id_oauth_grant_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."oauth_grant_references"("id") ON DELETE cascade ON UPDATE no action;