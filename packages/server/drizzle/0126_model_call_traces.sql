CREATE TABLE "model_call_payloads" (
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"request_body" "bytea" NOT NULL,
	"response_body" "bytea" NOT NULL,
	"request_truncated" boolean NOT NULL,
	"response_truncated" boolean NOT NULL,
	"response_partial" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_call_payloads_workspace_id_call_id_pk" PRIMARY KEY("workspace_id","call_id"),
	CONSTRAINT "model_call_payloads_size" CHECK (octet_length("model_call_payloads"."request_body") <= 32768 and octet_length("model_call_payloads"."response_body") <= 32768)
);
--> statement-breakpoint
ALTER TABLE "model_call_payloads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"routine_id" uuid,
	"release_digest" text,
	"function_id" uuid,
	"provider" text NOT NULL,
	"requested_model" text,
	"returned_model" text,
	"provider_request_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"outcome" text NOT NULL,
	"http_status" integer,
	"code" text,
	CONSTRAINT "model_calls_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "model_calls_owner_kind" CHECK ("model_calls"."owner_kind" in ('routine', 'extension')),
	CONSTRAINT "model_calls_outcome" CHECK ("model_calls"."outcome" in ('started', 'completed', 'provider_error', 'transport_error', 'stream_interrupted')),
	CONSTRAINT "model_calls_finish" CHECK (("model_calls"."outcome" = 'started' and "model_calls"."finished_at" is null and "model_calls"."duration_ms" is null)
      or ("model_calls"."outcome" <> 'started' and "model_calls"."finished_at" is not null and "model_calls"."duration_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "model_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_call_payloads" ADD CONSTRAINT "model_call_payloads_call_fk" FOREIGN KEY ("workspace_id","call_id") REFERENCES "public"."model_calls"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_payloads_expiry_idx" ON "model_call_payloads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "model_calls_retention_idx" ON "model_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "model_calls_owner_idx" ON "model_calls" USING btree ("workspace_id","owner_kind","owner_id","started_at");--> statement-breakpoint
CREATE POLICY "model_call_payloads_insert" ON "model_call_payloads" AS PERMISSIVE FOR INSERT TO "retainer_app" WITH CHECK ("model_call_payloads"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "model_calls_workspace" ON "model_calls" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("model_calls"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("model_calls"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);