DROP INDEX "auth_accounts_user_idx";--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_provider_uq" UNIQUE("user_id","provider_id");