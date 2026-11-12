DROP INDEX "extension_jobs_coalesce_idx";--> statement-breakpoint
ALTER TABLE "extension_jobs" ADD COLUMN "cause_depth" integer;--> statement-breakpoint
ALTER TABLE "record_changes" ADD COLUMN "cause_depth" integer;--> statement-breakpoint
CREATE INDEX "extension_jobs_coalesce_idx" ON "extension_jobs" USING btree ("installation_id","function_id",("change_snapshot"->>'record_id')) WHERE "extension_jobs"."status" in ('queued','running') and "extension_jobs"."trigger_kind" = 'change';