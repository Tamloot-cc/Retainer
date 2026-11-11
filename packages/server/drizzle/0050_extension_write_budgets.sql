CREATE TABLE "extension_write_budgets" (
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "extension_write_budgets_workspace_id_installation_id_pk" PRIMARY KEY("workspace_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ADD CONSTRAINT "extension_write_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_write_budgets" ADD CONSTRAINT "extension_write_budgets_install_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."extension_installations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "extension_write_budgets_workspace" ON "extension_write_budgets" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("extension_write_budgets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("extension_write_budgets"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);