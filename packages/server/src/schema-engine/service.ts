import type { SchemaDescription } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { readWorkspace } from '../db/workspaces.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { getSchema } from '../schema/compiled.js';
import { BUILT_INS, memoryBuiltIn } from './built-ins.js';
import { runSchemaChange, type SchemaChangeResult } from './engine.js';
import { schemaOperationSchema, stripUniversalIds } from './operations.js';
import { presentSchema, presentValueFormats } from './present.js';

export type { SchemaDescription } from '@retainer/shared';

/**
 * describe_schema and GET /v1/schema: the workspace, its objects and fields,
 * and the built-in facts (5).
 */
export async function describeSchema(sql: Sql, caller: Caller): Promise<SchemaDescription> {
  const { workspaceId } = caller;
  return inWorkspace(sql, workspaceId, async (tx) => {
    await lockSchemaShared(tx, workspaceId);
    await admitCaller(tx, caller, false, 'runtime');
    const [workspace, schema] = await Promise.all([
      readWorkspace(tx, workspaceId),
      getSchema(tx, workspaceId),
    ]);
    const objects = presentSchema(schema);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        templates: workspace.templates,
        initialized: workspace.initializedAt !== null,
        schemaVersion: schema.version,
      },
      objects,
      valueFormats: presentValueFormats(objects),
      builtIns: [
        ...BUILT_INS,
        memoryBuiltIn(
          caller.person && !caller.run && !caller.installation
            ? ['workspace', 'me']
            : ['workspace'],
        ),
      ],
    };
  });
}

export const schemaChangeRequestSchema = z.strictObject({
  operations: z.array(schemaOperationSchema).min(1).max(100),
  reason: z.string().max(2000).optional(),
});
export type SchemaChangeRequestBody = z.infer<typeof schemaChangeRequestSchema>;

/** propose_schema_change and POST /v1/schema/changes: applied or proposed (3). */
export async function requestSchemaChange(
  sql: Sql,
  caller: Caller,
  body: SchemaChangeRequestBody,
): Promise<SchemaChangeResult> {
  return inWorkspace(sql, caller.workspaceId, (tx) =>
    runSchemaChange(tx, {
      workspaceId: caller.workspaceId,
      actor: caller.actor,
      scopes: caller.scopes,
      // Universal IDs belong to code-defined schema, never to callers.
      operations: stripUniversalIds(body.operations),
      ...(body.reason ? { reason: body.reason } : {}),
    }),
  );
}
