import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { after, page } from '../../db/pagination.js';
import { SCHEMA_CHANGE_STATUSES } from '../../db/schema.js';
import { inWorkspace, lockSchemaShared } from '../../db/tx.js';
import { AppError } from '../../errors.js';
import { admitCaller } from '../../extension-runtime/admission.js';
import { idParam, limitParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import {
  decideSchemaChange,
  getSchemaChange,
  type SchemaChangeResult,
} from '../../schema-engine/engine.js';
import {
  describeSchema,
  requestSchemaChange,
  schemaChangeRequestSchema,
} from '../../schema-engine/service.js';

/** 200 applied or unchanged, 202 waiting for approval, 409 conflicting records. */
function statusFor(result: SchemaChangeResult): 200 | 202 | 409 {
  if (result.status === 'proposed') return 202;
  if (result.status === 'failed') return 409;
  return 200;
}

export function schemaRoutes(app: Hono<AppEnv>, sql: Sql) {
  /** describe_schema: the workspace and its objects and fields (5). */
  app.get('/schema', requireScope('read'), async (c) =>
    c.json(await describeSchema(sql, c.get('caller'))),
  );

  app.post('/schema/changes', requireScope('schema:write'), async (c) => {
    const body = await readBody(c, schemaChangeRequestSchema);
    const result = await requestSchemaChange(sql, c.get('caller'), body);
    return c.json(result, statusFor(result));
  });

  app.get('/schema/changes', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const status = c.req.query('status');
    if (status && !(SCHEMA_CHANGE_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(
        400,
        'invalid_request',
        `status must be one of: ${SCHEMA_CHANGE_STATUSES.join(', ')}`,
      );
    }
    return c.json(
      await inWorkspace(sql, workspaceId, async (tx) => {
        await lockSchemaShared(tx, workspaceId);
        await admitCaller(tx, c.get('caller'), false, 'runtime');
        const limit = limitParam(c, 50, 200);
        const where = status ? tx`status = ${status}` : tx`true`;
        const rows = await tx<
          { id: string; stamp: string }[]
        >`select id, created_at::text as stamp from schema_changes where ${where} and ${after(tx, tx`created_at`, tx`id`, c.req.query('cursor'), true)} order by created_at desc,id desc limit ${limit + 1}`;
        const result = page(rows, limit);
        const [total] = await tx<
          { count: number }[]
        >`select count(*)::int as count from schema_changes where ${where}`;
        return {
          changes: await Promise.all(
            result.items.map((r) => getSchemaChange(tx, workspaceId, r.id)),
          ),
          total: total?.count ?? 0,
          nextCursor: result.nextCursor,
        };
      }),
    );
  });

  app.get('/schema/changes/:id', requireScope('read'), async (c) => {
    const { workspaceId } = c.get('caller');
    const id = idParam(c);
    return c.json(
      await inWorkspace(sql, workspaceId, async (tx) => {
        await lockSchemaShared(tx, workspaceId);
        await admitCaller(tx, c.get('caller'), false, 'runtime');
        return getSchemaChange(tx, workspaceId, id);
      }),
    );
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/schema/changes/:id/${decision}`, requireScope('admin'), async (c) => {
      const caller = c.get('caller');
      const changeId = idParam(c);
      const result = await inWorkspace(sql, caller.workspaceId, (tx) =>
        decideSchemaChange(tx, {
          workspaceId: caller.workspaceId,
          changeId,
          actor: caller.actor,
          scopes: caller.scopes,
          decision,
        }),
      );
      return c.json(result, result.status === 'failed' ? 409 : 200);
    });
  }
}
