DROP INDEX "idempotency_keys_uq";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "acts_for_user" uuid;--> statement-breakpoint
ALTER TABLE "event_links" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "event_records" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "fact_sources" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "person_scope" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "private_to_user" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_acts_for_user_users_id_fk" FOREIGN KEY ("acts_for_user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_private_to_user_users_id_fk" FOREIGN KEY ("private_to_user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_private_to_user_users_id_fk" FOREIGN KEY ("private_to_user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_acts_for_idx" ON "api_keys" USING btree ("acts_for_user","workspace_id") WHERE "api_keys"."acts_for_user" is not null;--> statement-breakpoint
CREATE INDEX "idempotency_keys_private_idx" ON "idempotency_keys" USING btree ("private_to_user","workspace_id") WHERE "idempotency_keys"."private_to_user" is not null;--> statement-breakpoint
CREATE INDEX "records_private_idx" ON "records" USING btree ("private_to_user","workspace_id","object_type_id") WHERE "records"."private_to_user" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree ("workspace_id","operation","person_scope","key");