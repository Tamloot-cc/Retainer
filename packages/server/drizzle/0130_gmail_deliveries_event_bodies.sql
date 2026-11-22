ALTER TABLE "gmail_deliveries" DROP CONSTRAINT "gmail_deliveries_message_fk";
--> statement-breakpoint
ALTER TABLE "gmail_deliveries" ADD CONSTRAINT "gmail_deliveries_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."event_bodies"("workspace_id","event_id") ON DELETE cascade ON UPDATE no action;