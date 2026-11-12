ALTER TABLE "record_changes" DROP CONSTRAINT "record_changes_operation";--> statement-breakpoint
ALTER TABLE "record_changes" ALTER COLUMN "record_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "record_changes" ADD CONSTRAINT "record_changes_schema_record" CHECK (("record_changes"."operation"='schema')=("record_changes"."record_id" is null));--> statement-breakpoint
ALTER TABLE "record_changes" ADD CONSTRAINT "record_changes_operation" CHECK ("record_changes"."operation" in ('create','update','links','delete','merge','retract','supersede','review','forget','schema'));