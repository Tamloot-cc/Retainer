import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { type ApplyTemplateResult, applyTemplate } from './apply.js';
import { listTemplates, type TemplateView } from './catalog.js';

/** list_templates and GET /v1/templates: every template, marked if applied (3.1). */
export async function templatesFor(
  sql: Sql,
  caller: Caller,
): Promise<{ templates: TemplateView[] }> {
  const { workspaceId } = caller;
  const [workspace] = await inWorkspace(sql, workspaceId, async (tx) => {
    await lockSchemaShared(tx, workspaceId);
    await admitCaller(tx, caller, false, 'runtime');
    return tx<
      { templates: { name: string }[] }[]
    >`select templates from workspaces where id = ${workspaceId}`;
  });
  return { templates: listTemplates(workspace?.templates.map((t) => t.name) ?? []) };
}

/** apply_template and POST /v1/templates/:name/apply. */
export async function applyTemplateFor(
  sql: Sql,
  caller: Caller,
  name: string,
): Promise<ApplyTemplateResult> {
  return inWorkspace(sql, caller.workspaceId, (tx) =>
    applyTemplate(tx, {
      workspaceId: caller.workspaceId,
      actor: caller.actor,
      scopes: caller.scopes,
      name,
    }),
  );
}
