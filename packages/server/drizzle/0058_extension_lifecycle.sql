ALTER TABLE "extension_installations" ADD COLUMN "connection_health" text DEFAULT 'needs_reconnect' NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "setup_kind" text DEFAULT 'install' NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "cleanup_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "trigger_kind" text DEFAULT 'job' NOT NULL;