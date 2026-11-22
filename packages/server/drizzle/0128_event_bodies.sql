CREATE TABLE "event_bodies" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"original_date" timestamp with time zone,
	"body" text NOT NULL,
	"search" "tsvector" NOT NULL,
	CONSTRAINT "event_bodies_ws_id_uq" UNIQUE("workspace_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "event_bodies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_bodies" ADD CONSTRAINT "event_bodies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bodies" ADD CONSTRAINT "event_bodies_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_bodies_thread_idx" ON "event_bodies" USING btree ("workspace_id","thread_id","occurred_at","event_id") WHERE "event_bodies"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX "event_bodies_search_gin" ON "event_bodies" USING gin ("workspace_id","search");--> statement-breakpoint
CREATE POLICY "event_bodies_workspace" ON "event_bodies" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("event_bodies"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("event_bodies"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);