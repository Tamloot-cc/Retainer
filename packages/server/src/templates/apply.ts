import type { Actor } from '@retainer/shared';
import type { ApiKeyScope, AppliedTemplate } from '../db/schema.js';
import { lockSchemaExclusive, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { seedWorkspaceProfile } from '../memory/profiles.js';
import { runSchemaChange, type SchemaChangeResult, SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { SEED_OPERATIONS } from './base.js';
import { getTemplate, TEMPLATE_NAMES } from './index.js';

/**
 * Creates the base objects, the base event types and the hidden internal-note
 * type in a new workspace. Code-defined schema goes
 * through the same engine on its trusted path (person.emails is unique,
 * which would otherwise need approval).
 */
export async function seedBaseObjects(tx: Tx, workspaceId: string): Promise<void> {
  await runSchemaChange(tx, {
    workspaceId,
    actor: SYSTEM_ACTOR,
    scopes: [],
    operations: SEED_OPERATIONS,
    reason: 'Base objects',
    owner: 'system',
    trusted: true,
  });
  // Workspace memory exists from the start (personal memory spec 4.1).
  await seedWorkspaceProfile(tx, workspaceId, SYSTEM_ACTOR);
}

export type ApplyTemplateResult = SchemaChangeResult & { alreadyApplied: boolean };

/**
 * Applies a template (3.1) as owner `system`. Template operations are all
 * additive, so they apply without approval; a name collision with a custom
 * object or field fails validation and lists every collision, and nothing
 * is half-applied. Applying a template twice is a no-op.
 */
export async function applyTemplate(
  tx: Tx,
  input: { workspaceId: string; actor: Actor; scopes: readonly ApiKeyScope[]; name: string },
): Promise<ApplyTemplateResult> {
  const template = getTemplate(input.name);
  if (!template) {
    throw notFound(`template "${input.name}"`, { templates: [...TEMPLATE_NAMES] });
  }
  // Held through the whole transaction, so two concurrent applies serialize.
  await lockSchemaExclusive(tx, input.workspaceId);
  const [workspace] = await tx<{ templates: AppliedTemplate[]; schema_version: number }[]>`
    select templates, schema_version from workspaces where id = ${input.workspaceId}`;
  if (!workspace) throw notFound('workspace');
  if (workspace.templates.some((t) => t.name === template.name)) {
    return {
      status: 'unchanged',
      change: null,
      schemaVersion: workspace.schema_version,
      alreadyApplied: true,
    };
  }

  const result = await runSchemaChange(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    scopes: input.scopes,
    operations: template.operations,
    reason: `Template ${template.name} v${template.version}`,
    owner: 'system',
  });
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    // Templates are additive by construction; anything else is a bug.
    throw new AppError(409, 'template_not_applied', `template change was ${result.status}`);
  }

  const applied: AppliedTemplate = {
    name: template.name,
    version: template.version,
    appliedAt: new Date().toISOString(),
  };
  await tx`
    update workspaces
    set templates = templates || ${tx.json([applied])},
      initialized_at = coalesce(initialized_at, now()), updated_at = now()
    where id = ${input.workspaceId}`;
  return { ...result, alreadyApplied: false };
}
