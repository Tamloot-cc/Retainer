CREATE TABLE "assertion_dependencies" (
	"workspace_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"support_record_id" uuid NOT NULL,
	CONSTRAINT "assertion_dependencies_workspace_id_assertion_id_support_record_id_pk" PRIMARY KEY("workspace_id","assertion_id","support_record_id")
);
--> statement-breakpoint
ALTER TABLE "assertion_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assertion_dependencies" ADD CONSTRAINT "assertion_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertion_dependencies" ADD CONSTRAINT "assertion_dependencies_assertion_fk" FOREIGN KEY ("workspace_id","assertion_id") REFERENCES "public"."field_assertions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertion_dependencies" ADD CONSTRAINT "assertion_dependencies_support_fk" FOREIGN KEY ("workspace_id","support_record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assertion_dependencies_support_idx" ON "assertion_dependencies" USING btree ("workspace_id","support_record_id");--> statement-breakpoint
CREATE POLICY "assertion_dependencies_workspace" ON "assertion_dependencies" AS PERMISSIVE FOR ALL TO "retainer_app" USING ("assertion_dependencies"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK ("assertion_dependencies"."workspace_id"=nullif(current_setting('app.workspace_id',true),'')::uuid);