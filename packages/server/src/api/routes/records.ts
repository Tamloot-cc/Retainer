import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { clearMyMemory } from '../../memory/service.js';
import { aggregateInputSchema } from '../../records/aggregate.js';
import { mergeInputSchema } from '../../records/merge.js';
import { queryInputSchema } from '../../records/query.js';
import {
  aggregate,
  bulkDeleteImpact,
  bulkDeleteImpactSchema,
  createRecord,
  decideAssertion,
  deleteImpact,
  deleteRecord,
  dismissSuggestion,
  findRecords,
  forget,
  mergeRecord,
  patchInputSchema,
  patchRecord,
  readRecord,
  sourceSchema,
  upsertInputSchema,
  upsertRecord,
  valuesSchema,
} from '../../records/service.js';

const createSchema = z.strictObject({ values: valuesSchema, source: sourceSchema.optional() });

export function recordRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/objects/:object/records', requireScope('write'), async (c) => {
    const { values, source } = await readBody(c, createSchema);
    const idempotencyKey = c.req.header('idempotency-key');
    const result = await createRecord(sql, c.get('caller'), c.req.param('object'), values, {
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(source !== undefined ? { source } : {}),
    });
    return c.json(result, 201);
  });

  app.post('/objects/:object/query', requireScope('read'), async (c) => {
    const input = await readBody(c, queryInputSchema);
    return c.json(await findRecords(sql, c.get('caller'), c.req.param('object'), input));
  });

  app.post('/objects/:object/aggregate', requireScope('read'), async (c) => {
    const input = await readBody(c, aggregateInputSchema);
    return c.json(await aggregate(sql, c.get('caller'), c.req.param('object'), input));
  });

  app.post('/records/delete-impact', requireScope('read'), async (c) =>
    c.json(await bulkDeleteImpact(sql, c.get('caller'), await readBody(c, bulkDeleteImpactSchema))),
  );

  app.post('/objects/:object/upsert', requireScope('write'), async (c) => {
    const input = await readBody(c, upsertInputSchema);
    const result = await upsertRecord(sql, c.get('caller'), c.req.param('object'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/records/:id', requireScope('read'), async (c) =>
    c.json(await readRecord(sql, c.get('caller'), idParam(c))),
  );

  app.patch('/records/:id', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, patchInputSchema);
    return c.json(await patchRecord(sql, c.get('caller'), id, input));
  });

  app.get('/records/:id/delete-impact', requireScope('read'), async (c) =>
    c.json(await deleteImpact(sql, c.get('caller'), idParam(c))),
  );

  app.delete('/records/:id', requireScope('write'), async (c) =>
    c.json(await deleteRecord(sql, c.get('caller'), idParam(c))),
  );

  app.post('/records/:id/merge', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, mergeInputSchema);
    const key = c.req.header('idempotency-key');
    return c.json(await mergeRecord(sql, c.get('caller'), id, input, key));
  });

  /**
   * "Clear all" (personal memory spec 4.6): a signed-in person deletes their
   * own personal memory here. Not for API keys or OAuth agents, and only
   * `me`: workspace memory and other records are forgotten below. Before
   * that route, whose admin check would otherwise answer first.
   */
  app.post('/records/me/forget', requireScope('read'), async (c) =>
    c.json(await clearMyMemory(sql, c.get('caller'))),
  );

  app.post('/records/:id/forget', requireScope('admin'), async (c) =>
    c.json(await forget(sql, c.get('caller'), idParam(c))),
  );

  app.post('/review/merges/:id/dismiss', requireScope('write'), async (c) =>
    c.json(await dismissSuggestion(sql, c.get('caller'), idParam(c))),
  );

  for (const decision of ['accept', 'reject'] as const) {
    app.post(`/assertions/:id/${decision}`, requireScope('write'), async (c) =>
      c.json(await decideAssertion(sql, c.get('caller'), idParam(c), decision)),
    );
  }
}
