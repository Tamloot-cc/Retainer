ALTER TABLE "schema_changes" ADD COLUMN "template" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "schema_from_scratch";