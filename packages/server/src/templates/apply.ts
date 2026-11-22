import type { Actor } from '@retainer/shared';
import type { ApiKeyScope } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { seedWorkspaceProfile } from '../memory/profiles.js';
import { runSchemaChange, type SchemaChangeResult, SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { definitionsFor } from './definitions.js';
import { getTemplate, TEMPLATE_NAMES, templateOperations } from './index.js';

export async function seedWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  const definitions = definitionsFor();
  const result = await runSchemaChange(tx, {
    workspaceId,
    actor: SYSTEM_ACTOR,
    scopes: [],
    operations: definitions.operations,
    reason: 'Internal workspace types',
    owner: 'system',
    trusted: true,
  });
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw new AppError(409, 'seed_not_applied', `internal workspace types were ${result.status}`);
  }
  await seedWorkspaceProfile(tx, workspaceId, SYSTEM_ACTOR);
  await tx`update workspaces set definitions_digest = ${definitions.digest} where id = ${workspaceId}`;
}

export async function applyTemplate(
  tx: Tx,
  input: {
    workspaceId: string;
    actor: Actor;
    scopes: readonly ApiKeyScope[];
    name: string;
    trusted?: boolean;
  },
): Promise<SchemaChangeResult> {
  const template = getTemplate(input.name);
  if (!template) {
    throw notFound(`template "${input.name}"`, { templates: [...TEMPLATE_NAMES] });
  }
  return runSchemaChange(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    scopes: input.scopes,
    operations: templateOperations(template),
    reason: `Template ${template.name} v${template.version}`,
    template: { name: template.name, version: template.version },
    owner: 'workspace',
    trusted: input.trusted,
  });
}
