ALTER TABLE "routine_runs" DROP CONSTRAINT "routine_runs_mode";--> statement-breakpoint
ALTER TABLE "routine_runs" DROP CONSTRAINT "routine_runs_trigger_kind";--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_mode" CHECK ("routine_runs"."mode" in ('run', 'test', 'dry', 'check'));--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_kind" CHECK ("routine_runs"."trigger_kind" in ('record', 'schedule', 'manual', 'test', 'preview', 'check'));