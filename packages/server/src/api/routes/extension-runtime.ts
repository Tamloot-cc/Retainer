import { functionSecrets } from '@retainer/extension';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import type { Sql } from '../../db/client.js';
import { inWorkspace, lockSchemaShared } from '../../db/tx.js';
import { AppError, notFound } from '../../errors.js';
import { admitRun } from '../../extension-runtime/admission.js';
import { ExtensionQueue, type Lease } from '../../extension-runtime/queue.js';
import type { SecretBroker } from '../../extension-runtime/secrets.js';
import type { ExtensionCatalog } from '../../extensions/catalog.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

/** A run-only surface. Admin credentials cannot impersonate an installed function. */
export function runtimeRoutes(
  app: Hono<AppEnv>,
  sql: Sql,
  catalog: ExtensionCatalog,
  broker?: SecretBroker,
) {
  const queue = new ExtensionQueue(sql, catalog.runtime);
  app.post('/extensions/:id/runs/:run/retry', async (c) =>
    c.json(
      await queue.retry(
        c.get('caller'),
        idParam(c),
        idParam(c, 'run'),
        c.req.header('Idempotency-Key') ?? '',
      ),
    ),
  );
  app.use('/extensions/:id/runtime/*', async (c, next) => {
    const caller = c.get('caller'),
      id = idParam(c);
    if (!caller.run)
      throw new AppError(403, 'forbidden', 'this endpoint requires a live run credential');
    if (caller.run.installationId !== id) throw notFound('extension installation');
    await next();
  });
  const lease = (caller: AppEnv['Variables']['caller']): Lease => {
    if (!caller.run) throw new AppError(403, 'forbidden', 'run credential required');
    return { workspaceId: caller.workspaceId, ...caller.run };
  };
  const secretIdentity = async (caller: Caller, name: string, writing = false) => {
    const run = caller.run;
    if (!run) throw new AppError(403, 'forbidden', 'run credential required');
    // Release these API locks before the broker acquires its own admission locks.
    return inWorkspace(sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const [installation] = await tx<
        { version: string }[]
      >`select version from extension_installations where id=${run.installationId}`;
      if (!installation) throw notFound('extension installation');
      const release = catalog.get(run.registrationId, installation.version),
        definition = release.manifest.settings[name],
        fn = release.manifest.functions.find((f) => f.universalId === run.functionId);
      // A run reaches only the secrets its own function declares (spec 8).
      if (
        release.digest !== run.releaseDigest ||
        !definition?.secret ||
        !fn ||
        !functionSecrets(release.manifest, fn).includes(name)
      )
        throw notFound('connection secret');
      if (writing && !definition.generated)
        throw new AppError(403, 'forbidden', 'runs can write only declared generated secrets');
      return {
        workspaceId: caller.workspaceId,
        installationId: run.installationId,
        registrationId: run.registrationId,
        name,
      };
    });
  };
  app.get('/extensions/:id/runtime/secrets/:name', async (c) => {
    if (!broker) throw new AppError(503, 'connection_required', 'secret broker is not configured');
    const caller = c.get('caller');
    if (!caller.run) throw new AppError(403, 'forbidden', 'run credential required');
    const identity = await secretIdentity(caller, c.req.param('name'));
    return c.json(await broker.readRuntime(identity, caller.run));
  });
  app.put('/extensions/:id/runtime/secrets/:name', async (c) => {
    if (!broker) throw new AppError(503, 'connection_required', 'secret broker is not configured');
    const caller = c.get('caller');
    if (!caller.run) throw new AppError(403, 'forbidden', 'run credential required');
    const input = await readBody(
      c,
      z.strictObject({
        expectedRevision: z.number().int().positive().max(2147483647).nullable(),
        value: z.string().min(1).max(65536),
      }),
    );
    const identity = await secretIdentity(caller, c.req.param('name'), true);
    return c.json(
      await broker.writeRuntime(identity, caller.run, input.expectedRevision, input.value),
    );
  });
  app.get('/extensions/:id/runtime/kv/:key', async (c) =>
    c.json(await queue.getKv(lease(c.get('caller')), c.req.param('key'))),
  );
  app.post('/extensions/:id/runtime/checkpoint', async (c) =>
    c.json(
      await queue.checkpoint(
        lease(c.get('caller')),
        await readBody(
          c,
          z.strictObject({
            scanComplete: z
              .strictObject({ scanId: z.uuid(), through: z.iso.datetime({ offset: true }) })
              .optional(),
            children: z
              .array(
                z.strictObject({
                  functionId: z.uuid(),
                  input: z.json(),
                  dedupeKey: z.string().min(1).max(500),
                }),
              )
              .max(1000),
            kv: z
              .strictObject({
                key: z.string().min(1).max(200),
                expectedRevision: z.number().int().positive().nullable(),
                value: z.json(),
              })
              .optional(),
          }),
        ),
      ),
    ),
  );
}
