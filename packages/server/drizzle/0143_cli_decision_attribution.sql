ALTER TABLE "extension_installations" ADD COLUMN "state_changed_by" jsonb;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD COLUMN "rejected_by" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "state_changed_by" jsonb;