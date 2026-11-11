CREATE TABLE "source_sync_state" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"scan_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"lower_bound" timestamp with time zone NOT NULL,
	"upper_bound" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_successful_scan_at" timestamp with time zone,
	CONSTRAINT "source_sync_state_workspace_id_installation_id_pk" PRIMARY KEY("workspace_id","installation_id"),
	CONSTRAINT "source_sync_mode" CHECK ("source_sync_state"."mode" in ('created','updated')),
	CONSTRAINT "source_sync_bounds" CHECK ("source_sync_state"."lower_bound"<="source_sync_state"."upper_bound")
);
--> statement-breakpoint
ALTER TABLE "source_sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "source_sync_workspace" ON "source_sync_state" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("source_sync_state"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("source_sync_state"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);