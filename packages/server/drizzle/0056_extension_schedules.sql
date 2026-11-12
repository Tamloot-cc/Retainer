CREATE TABLE "extension_schedules" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_occurrence" timestamp with time zone,
	CONSTRAINT "extension_schedules_workspace_id_installation_id_function_id_pk" PRIMARY KEY("workspace_id","installation_id","function_id")
);
--> statement-breakpoint
ALTER TABLE "extension_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_schedules" ADD CONSTRAINT "extension_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_schedules" ADD CONSTRAINT "extension_schedules_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "extension_schedules_workspace" ON "extension_schedules" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_schedules"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_schedules"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);