import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import type { FileStorage } from '../../file-storage/contract.js';
import { Files, fileMetadataSchema } from '../../files/service.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
export function fileRoutes(app: Hono<AppEnv>, sql: Sql, storage?: FileStorage, quota?: number) {
  const files = new Files(sql, storage, quota);
  app.post('/files/erasure-status', requireScope('admin'), async (c) =>
    c.json(
      await files.erasureStatus(
        c.get('caller'),
        (await readBody(c, z.strictObject({ ids: z.array(z.uuid()).min(1).max(10000) }))).ids,
      ),
    ),
  );
  app.post('/files/intents', requireScope('write'), async (c) =>
    c.json(
      await files.intent(
        c.get('caller'),
        await readBody(c, fileMetadataSchema),
        c.req.header('Idempotency-Key') ?? '',
      ),
      201,
    ),
  );
  app.post('/files/:id/finalize', requireScope('write'), async (c) =>
    c.json(await files.finalize(c.get('caller'), idParam(c))),
  );
  app.get('/files/:id', requireScope('read'), async (c) =>
    c.json(await files.get(c.get('caller'), idParam(c))),
  );
  app.post('/files/:id/download', requireScope('read'), async (c) =>
    c.json(await files.download(c.get('caller'), idParam(c))),
  );
}
