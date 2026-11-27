import type { Hono } from 'hono';
import { z } from 'zod';
import { missingScope, requireScope } from '../../auth/middleware.js';
import { AppError } from '../../errors.js';
import {
  authorizeInputSchema,
  completeAuthorizationSchema,
  connectionInputSchema,
  dismissNoticeSchema,
} from '../../extensions/connections.js';
import {
  commitInputSchema,
  type Extensions,
  installInputSchema,
  runStatusFilterSchema,
} from '../../extensions/service.js';
import { idParam, limitParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

export function extensionRoutes(app: Hono<AppEnv>, extensions: Extensions, keyMode = true) {
  app.get('/extensions/:id/bindings', async (c) => {
    const caller = c.get('caller');
    // Standalone writes need the revision and stable IDs in their own plan.
    const ownWrite =
      caller.installation?.installationId === c.req.param('id') && caller.scopes.includes('write');
    const missing = ownWrite ? undefined : missingScope(caller, 'read');
    if (missing) throw missing;
    return c.json(await extensions.bindings(caller, idParam(c)));
  });
  app.get('/extensions/:id/suggestions', requireScope('read'), async (c) =>
    c.json(await extensions.suggestions(c.get('caller'), idParam(c), c.req.query('version'))),
  );
  app.delete('/extensions/:id/suggestions', requireScope('admin'), async (c) =>
    c.json(await extensions.cancelConfigure(c.get('caller'), idParam(c), c.req.query('version'))),
  );
  app.post('/extensions/:id/configure', requireScope('admin'), async (c) => {
    const input = await readBody(c, z.strictObject({ version: z.string().optional() }));
    return c.json(await extensions.configure(c.get('caller'), idParam(c), input.version), 202);
  });
  app.delete('/extensions/:id', requireScope('admin'), async (c) =>
    c.json(await extensions.transition(c.get('caller'), idParam(c), 'uninstalled')),
  );
  for (const action of ['turn-on', 'access'] as const)
    app.post(`/extensions/:id/${action}`, requireScope('admin'), async (c) => {
      const id = idParam(c),
        input = await readBody(c, commitInputSchema);
      if (input.installationId !== id || (action === 'turn-on' ? !input.turnOn : !input.accessOnly))
        throw new AppError(
          400,
          'invalid_request',
          'review the matching plan for this installation',
        );
      return c.json(
        await extensions.install(c.get('caller'), input, c.req.header('Idempotency-Key') ?? ''),
      );
    });
  app.get('/extensions/:id/connections', requireScope('read'), async (c) =>
    c.json(await extensions.connections.list(c.get('caller'), idParam(c))),
  );
  app.post('/extensions/:id/connections/secrets', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.stage(
        c.get('caller'),
        idParam(c),
        await readBody(
          c,
          z.strictObject({
            connectionId: z.uuid().optional(),
            name: z.string().min(1).max(100),
            value: z.string().min(1).max(65536),
          }),
        ),
      ),
      201,
    ),
  );
  app.post('/extensions/:id/connections', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.connect(
        c.get('caller'),
        idParam(c),
        await readBody(c, connectionInputSchema),
      ),
      201,
    ),
  );
  app.post('/extensions/:id/connections/gmail/authorize', requireScope('read'), async (c) => {
    const { historyDays } = await readBody(
      c,
      z.strictObject({
        shareGmail: z.literal(true),
        historyDays: z.number().int().min(0).max(3650),
      }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(
      await extensions.connections.startGmailAuthorization(
        c.get('caller'),
        idParam(c),
        historyDays,
      ),
      201,
    );
  });
  app.post('/extensions/:id/connections/gmail/complete', requireScope('read'), async (c) => {
    const { attemptId } = await readBody(c, z.strictObject({ attemptId: z.uuid() }));
    return c.json(
      await extensions.connections.finishGmailAuthorization(c.get('caller'), idParam(c), attemptId),
    );
  });
  app.post('/extensions/:id/connections/authorize', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.authorize(
        c.get('caller'),
        idParam(c),
        await readBody(c, authorizeInputSchema),
      ),
      201,
    ),
  );
  app.post('/extensions/:id/connections/authorize/complete', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.completeAuthorization(
        c.get('caller'),
        idParam(c),
        await readBody(c, completeAuthorizationSchema),
      ),
    ),
  );
  app.post(
    '/extensions/:id/connections/:connection/release-notice/dismiss',
    requireScope('read'),
    async (c) =>
      c.json(
        await extensions.connections.dismissReleaseNotice(
          c.get('caller'),
          idParam(c),
          idParam(c, 'connection'),
          (await readBody(c, dismissNoticeSchema)).at,
        ),
      ),
  );
  app.post('/extensions/:id/connections/:connection/reconnect', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.connect(
        c.get('caller'),
        idParam(c),
        await readBody(c, connectionInputSchema),
        idParam(c, 'connection'),
      ),
    ),
  );
  app.delete('/extensions/:id/connections/:connection', requireScope('read'), async (c) =>
    c.json(
      await extensions.connections.disconnect(
        c.get('caller'),
        idParam(c),
        idParam(c, 'connection'),
      ),
    ),
  );

  app.post('/extensions/secrets', requireScope('admin'), async (c) =>
    c.json(
      await extensions.stageSecret(
        c.get('caller'),
        await readBody(
          c,
          z.strictObject({
            registrationId: z.uuid(),
            version: z.string(),
            installationId: z.uuid().optional(),
            name: z.string().min(1).max(100),
            value: z.string().min(1).max(65536),
          }),
        ),
      ),
      201,
    ),
  );
  app.get('/extensions/:id/credentials', requireScope('admin'), async (c) =>
    c.json(await extensions.credentials(c.get('caller'), idParam(c))),
  );
  app.post('/extensions/:id/keys', requireScope('admin'), async (c) => {
    if (!keyMode)
      throw new AppError(403, 'forbidden', 'accounts-mode standalone apps connect through OAuth');
    return c.json(
      await extensions.issueKey(
        c.get('caller'),
        idParam(c),
        await readBody(
          c,
          z.strictObject({
            expectedGeneration: z.number().int().positive(),
            scopes: z
              .array(z.enum(['read', 'write']))
              .min(1)
              .max(2),
          }),
        ),
      ),
      201,
    );
  });
  app.delete('/extensions/:id/credentials/:credential', requireScope('admin'), async (c) =>
    c.json(
      await extensions.revokeCredential(
        c.get('caller'),
        idParam(c),
        z.uuid().parse(c.req.param('credential')),
      ),
    ),
  );
  app.get('/extensions/links', requireScope('read'), async (c) =>
    c.json(await extensions.appLinks(c.get('caller'))),
  );
  app.get('/extensions/catalog', requireScope('read'), async (c) =>
    c.json(await extensions.offered(c.get('caller'))),
  );
  app.get('/extensions', requireScope('read'), async (c) =>
    c.json(await extensions.list(c.get('caller'))),
  );
  app.get('/extensions/record-buttons', requireScope('write'), async (c) =>
    c.json(await extensions.recordButtons(c.get('caller'), c.req.query('object') ?? '')),
  );
  app.post('/extensions/:id/record-buttons/:functionId', requireScope('write'), async (c) => {
    const { recordId } = await readBody(c, z.strictObject({ recordId: z.uuid() }));
    return c.json(
      await extensions.runRecordButton(
        c.get('caller'),
        idParam(c),
        idParam(c, 'functionId'),
        recordId.toLowerCase(),
      ),
      202,
    );
  });
  app.get('/extensions/:id/record-button-runs/:run', requireScope('write'), async (c) =>
    c.json(await extensions.recordButtonRun(c.get('caller'), idParam(c), idParam(c, 'run'))),
  );
  app.get('/extensions/:id', requireScope('read'), async (c) =>
    c.json(await extensions.get(c.get('caller'), idParam(c))),
  );
  app.get('/extensions/:id/usage', requireScope('read'), async (c) =>
    c.json(await extensions.usage(c.get('caller'), idParam(c))),
  );
  app.get('/extensions/:id/runs', requireScope('read'), async (c) =>
    c.json(
      await extensions.runs(
        c.get('caller'),
        idParam(c),
        limitParam(c, 50, 100),
        c.req.query('cursor'),
        c.req.query('connection') ? z.uuid().parse(c.req.query('connection')) : undefined,
        runStatusFilterSchema.optional().parse(c.req.query('status')),
      ),
    ),
  );
  app.get('/extensions/:id/runs/:run', requireScope('read'), async (c) =>
    c.json(await extensions.inspectRun(c.get('caller'), idParam(c), idParam(c, 'run'))),
  );
  app.post('/extensions/preview', requireScope('schema:write'), async (c) =>
    c.json(await extensions.preview(c.get('caller'), await readBody(c, installInputSchema))),
  );
  app.post('/extensions', requireScope('admin'), async (c) =>
    c.json(
      await extensions.install(
        c.get('caller'),
        await readBody(c, commitInputSchema),
        c.req.header('Idempotency-Key') ?? '',
      ),
      201,
    ),
  );
  app.post('/extensions/:id/upgrade', requireScope('admin'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, commitInputSchema);
    if (input.installationId && input.installationId !== id)
      throw new AppError(404, 'not_found', 'extension installation not found');
    return c.json(
      await extensions.install(
        c.get('caller'),
        { ...input, installationId: id },
        c.req.header('Idempotency-Key') ?? '',
      ),
    );
  });
  app.post('/extensions/:id/reconnect', requireScope('admin'), async (c) => {
    const id = idParam(c),
      input = await readBody(c, commitInputSchema);
    if (!input.reconnect || input.installationId !== id)
      throw new AppError(
        400,
        'invalid_request',
        'review a reconnect plan for this installation first',
      );
    return c.json(
      await extensions.install(c.get('caller'), input, c.req.header('Idempotency-Key') ?? ''),
    );
  });
  app.patch('/extensions/:id/settings', requireScope('admin'), async (c) =>
    c.json(
      await extensions.updateSettings(
        c.get('caller'),
        idParam(c),
        await readBody(
          c,
          z.strictObject({
            expectedRevision: z.number().int().positive(),
            settings: installInputSchema.shape.settings,
          }),
        ),
      ),
    ),
  );
  for (const [action, state] of [
    ['disable', 'disabled'],
    ['uninstall', 'uninstalled'],
  ] as const) {
    app.post(`/extensions/:id/${action}`, requireScope('admin'), async (c) =>
      c.json(await extensions.transition(c.get('caller'), idParam(c), state)),
    );
  }
  app.post('/extensions/:id/enable', requireScope('admin'), async (c) =>
    c.json(await extensions.enable(c.get('caller'), idParam(c))),
  );
}
