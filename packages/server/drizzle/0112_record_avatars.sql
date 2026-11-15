ALTER TABLE "object_types" ADD COLUMN "avatar_field" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "external_record_images" boolean DEFAULT false NOT NULL;