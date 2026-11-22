import { functionSecrets } from '@retainer/extension';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import type { Sql } from '../../db/client.js';
import { inWorkspace, lockSchemaShared } from '../../db/tx.js';
import { AppError, notFound } from '../../errors.js';
import { admitInstallation, admitRun } from '../../extension-runtime/admission.js';
import { ExtensionQueue, type Lease } from '../../extension-runtime/queue.js';
import type { SecretBroker } from '../../extension-runtime/secrets.js';
import type { ExtensionCatalog } from '../../extensions/catalog.js';
import { mappedWrite, mappedWriteSchema } from '../../extensions/mapped-write.js';
import { type ExtensionOAuthClients, oauthClientFor } from '../../extensions/oauth-clients.js';
import { saveSuggestions, suggestionsSchema } from '../../extensions/suggestions.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

/**
 * A run-only surface, plus a standalone app's generated-secret write. Admin
 * credentials cannot impersonate an installed function.
 */
export function runtimeRoutes(
  app: Hono<AppEnv>,
  sql: Sql,
  catalog: ExtensionCatalog,
  broker?: SecretBroker,
  oauthClients: ExtensionOAuthClients = new Map(),
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
      const release = catalog.forRun(run);
      const definition = release.manifest.settings[name],
        fn = release.manifest.functions.find((f) => f.universalId === run.functionId);
      // A run reaches only the secrets its own function declares (spec 8).
      if (!definition?.secret || !fn || !functionSecrets(release.manifest, fn).includes(name))
        throw notFound('connection secret');
      if (writing && (fn.trigger.kind === 'configure' || !definition.generated))
        throw new AppError(403, 'forbidden', 'runs can write only declared generated secrets');
      return {
        workspaceId: caller.workspaceId,
        installationId: run.installationId,
        connectionId: run.connectionId,
        registrationId: run.registrationId,
        name,
      };
    });
  };
  /**
   * The operator's OAuth client, for a live run whose function declares the
   * release's token secret (Tamloot connect spec 4.6). Cleanup hooks are
   * admitted as for a secret read; a configure run never is.
   */
  app.get('/extensions/:id/runtime/oauth-client', async (c) => {
    const caller = c.get('caller'),
      run = caller.run;
    if (!run) throw new AppError(403, 'forbidden', 'run credential required');
    const client = await inWorkspace(sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const release = catalog.forRun(run);
      const fn = release.manifest.functions.find((f) => f.universalId === run.functionId);
      const token = release.manifest.oauth?.tokenSetting;
      if (
        !fn ||
        !token ||
        fn.trigger.kind === 'configure' ||
        !functionSecrets(release.manifest, fn).includes(token)
      )
        throw new AppError(403, 'forbidden', 'this function cannot read the OAuth client');
      return oauthClientFor(release.manifest, oauthClients, !!broker);
    });
    if (!client) throw new AppError(409, 'oauth_unavailable', 'no OAuth client is configured');
    c.header('Cache-Control', 'no-store');
    return c.json({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: client.tokenEndpoint,
      redirectUri: client.redirectUri,
      ...(client.apiOrigin ? { apiOrigin: client.apiOrigin } : {}),
    });
  });
  app.put('/extensions/:id/runtime/suggestions', async (c) => {
    let input: z.infer<typeof suggestionsSchema>;
    try {
      input = await readBody(c, suggestionsSchema, 65536);
    } catch (error) {
      if (error instanceof AppError && ['invalid_request', 'quota_exceeded'].includes(error.code))
        throw new AppError(400, 'invalid_suggestions', 'invalid suggestions', error.details);
      throw error;
    }
    return c.json(await saveSuggestions(sql, catalog, c.get('caller'), input));
  });
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
  /**
   * A standalone app's own credential writes its installation's generated
   * secret, with the same revision CAS as a run (spec 8). This is how the app
   * hands its tool functions a shared key during its own connection flow, so
   * no admin fills in a form. It cannot read secrets or write any other kind.
   */
  app.put('/extensions/:id/generated-secrets/:name', async (c) => {
    if (!broker) throw new AppError(503, 'connection_required', 'secret broker is not configured');
    const caller = c.get('caller'),
      binding = caller.installation;
    if (!binding)
      throw new AppError(
        403,
        'forbidden',
        "only a standalone app's own credential writes its generated secrets",
      );
    if (binding.installationId !== idParam(c)) throw notFound('extension installation');
    const name = c.req.param('name');
    const input = await readBody(
      c,
      z.strictObject({
        expectedRevision: z.number().int().positive().max(2147483647).nullable(),
        value: z.string().min(1).max(65536),
      }),
    );
    // Release these API locks before the broker acquires its own admission locks.
    const digest = await inWorkspace(sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitInstallation(tx, caller.workspaceId, binding);
      const [row] = await tx<{ release_digest: string }[]>`
        select release_digest from extension_installations where id=${binding.installationId}`;
      const release = row && catalog.byDigest(binding.registrationId, row.release_digest);
      if (!release)
        throw new AppError(409, 'release_unavailable', 'the installed release is not loaded here');
      const definition = release.manifest.settings[name];
      if (!definition?.secret || !definition.generated || definition.level === 'connection')
        throw notFound('generated secret');
      return release.digest;
    });
    return c.json(
      await broker.writeInstallation(
        {
          workspaceId: caller.workspaceId,
          installationId: binding.installationId,
          registrationId: binding.registrationId,
          name,
        },
        binding,
        digest,
        input.expectedRevision,
        input.value,
      ),
    );
  });
  app.post('/extensions/:id/runtime/mapped-writes', async (c) =>
    c.json(await mappedWrite(sql, catalog, c.get('caller'), await readBody(c, mappedWriteSchema))),
  );
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
