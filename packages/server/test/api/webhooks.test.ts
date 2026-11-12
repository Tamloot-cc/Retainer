import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { InputSchema, VerificationInvocation, VerificationResult } from '@retainer/extension';
import { BASE_EVENT_TYPE_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { extensionServices } from '../../src/extension-control/configuration.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { IngressLimiter } from '../../src/webhooks/limiter.js';
import { Webhooks } from '../../src/webhooks/service.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
import { ExecutionRegistry } from '../../src/worker/extensions.js';
import type { VerificationDriver } from '../../src/worker/verifier-driver.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  setupId = randomUUID(),
  syncId = randomUUID(),
  verifierId = randomUUID(),
  globalVerifierId = randomUUID();
const input: InputSchema = {
  type: 'object',
  properties: { sourceItemId: { type: 'string', maxLength: 36 } },
  required: ['sourceItemId'],
  additionalProperties: false,
};
const manifest = extensionFixture({
  scopes: ['read', 'write'],
  source: {
    provider: 'fixture',
    identity: 'account',
    verifyFunctionId: setupId,
    syncFunctionIds: [syncId],
    eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
    revisionOrder: 'opaque',
  },
  settings: {
    signing: {
      type: 'string',
      label: 'Signing key',
      secret: true,
      generated: true,
      required: false,
      reconnect: false,
    },
  },
  functions: [
    {
      universalId: setupId,
      name: 'setup',
      description: 'Attest the fixture connection',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'install' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      universalId: syncId,
      name: 'sync',
      description: 'Sync a source',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'job' },
      inputSchema: input,
    },
    ...[
      { id: verifierId, route: 'notes', kind: 'route' as const },
      { id: globalVerifierId, route: 'global-notes', kind: 'serverRoute' as const },
    ].map((value) => ({
      universalId: value.id,
      name: value.route,
      description: 'Bounded verifier fixture',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 5,
      trigger: { kind: value.kind, route: value.route },
      inputSchema: { type: 'object' as const, additionalProperties: false as const },
    })),
  ],
  webhooks: [
    {
      route: 'notes',
      verifierFunctionId: verifierId,
      syncFunctionId: syncId,
      secretSetting: 'signing',
      headers: ['x-fixture-signature'],
      challenge: true,
    },
    {
      route: 'global-notes',
      verifierFunctionId: globalVerifierId,
      syncFunctionId: syncId,
      secretSetting: 'signing',
      headers: ['x-fixture-signature', 'provider-account'],
      accountHeader: 'provider-account',
    },
  ],
});
const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]),
  release = catalog.get(manifest.universalId, manifest.version);
const executables = manifest.functions.map((fn) => ({
  registrationId: manifest.universalId,
  releaseDigest: release.digest,
  functionId: fn.universalId,
  handlerDigest: fn.handlerDigest,
  packageDigest: manifest.packageDigest,
  runtimeVersion: 'node24' as const,
  driverTarget: 'fixture',
}));
const seen: VerificationInvocation[] = [],
  workspaces: string[] = [];
let verify: VerificationDriver['verify'], tokens: RunTokens, broker: SecretBroker;
const driver: VerificationDriver = { verify: (...args) => verify(...args) };
const normal: VerificationDriver['verify'] = async (_executable, invocation) => {
  seen.push(invocation);
  // An external verifier seam, not a DB mock. Real cryptographic/container behavior has its own live proof.
  if (invocation.headers['x-fixture-signature'] !== invocation.secret)
    return { status: 'rejected' };
  const body = JSON.parse(Buffer.from(invocation.rawBody, 'base64').toString()) as {
    delivery: string;
    source: string;
  };
  return { status: 'verified', deliveryId: body.delivery, externalId: body.source };
};
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'hooks',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
  verify = normal;
});
afterEach(async () => {
  verify = normal;
  seen.length = 0;
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});
async function setup(
  options: {
    account?: string;
    rateLimit?: number;
    activate?: boolean;
    optionalHooks?: boolean;
    beforeVerify?: (context: {
      app: ReturnType<typeof startTestApp>;
      id: string;
      token: string;
      workspace: string;
      secret: string;
      bindingId: string;
      url: string;
      admin: string;
    }) => Promise<void>;
  } = {},
) {
  const setupManifest = options.optionalHooks
    ? extensionFixture({
        ...manifest,
        webhooks: manifest.webhooks?.map((hook) => ({ ...hook, optional: true })),
      })
    : manifest;
  const setupCatalog = new ExtensionCatalog([
    { manifest: setupManifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]);
  const setupRelease = setupCatalog.get(setupManifest.universalId, setupManifest.version);
  const setupRegistry = new ExecutionRegistry(
    executables.map((entry) => ({ ...entry, releaseDigest: setupRelease.digest })),
  );
  const base = startTestApp(db);
  const hooks = new Webhooks({
    sql: base.sql,
    catalog: setupCatalog,
    broker,
    registry: setupRegistry,
    driver,
    publicOrigin: 'http://retainer.test',
    rateLimit: options.rateLimit,
  });
  const app = startTestApp(db, {
    extensionCatalog: setupCatalog,
    extensionActivation: new Set([setupRelease.digest]),
    extensionSecrets: broker,
    runTokens: tokens,
    webhooks: hooks,
    // The test stands in for the edge's view of the caller.
    clientIp: (c) => c.req.header('x-test-client-ip'),
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Webhook ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const request = {
      registrationId: setupManifest.universalId,
      version: setupManifest.version,
      settings: {},
    },
    plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: request });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...request, planDigest: plan.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    queue = new ExtensionQueue(app.sql, setupCatalog.runtime);
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const run = await queue.claim(workspace.id, job?.id, 'setup');
  if (!run) throw new Error('setup missing');
  const token = await tokens.issue(app.sql, run, setupManifest.universalId, ['read', 'write']),
    account = options.account ?? `account-${randomUUID()}`,
    secret = `candidate-${randomUUID()}`;
  const prepared = await app.request(`/v1/extensions/${id}/runtime/webhooks/prepare`, {
    key: token,
    body: { route: 'notes' },
  });
  expect(prepared.status).toBe(201);
  await options.beforeVerify?.({
    app,
    id,
    token,
    workspace: workspace.id,
    secret,
    bindingId: prepared.body.bindingId,
    url: prepared.body.url,
    admin: keys.admin,
  });
  const verified = await app.request(`/v1/extensions/${id}/source/verify`, {
    key: token,
    body: { accountId: account, sharing: 'workspace' },
  });
  expect(verified.status).toBe(200);
  expect(
    (
      await app.request(`/v1/extensions/${id}/runtime/secrets/signing`, {
        key: token,
        method: 'PUT',
        body: { expectedRevision: null, value: secret },
      })
    ).status,
  ).toBe(200);
  const bind = async (route: string, accountHint?: string) =>
    app.request(`/v1/extensions/${id}/runtime/webhooks`, {
      key: token,
      body: { route, ...(accountHint ? { accountHint } : {}) },
    });
  const bound = await bind('notes');
  expect(bound.status).toBe(201);
  expect(bound.body).toEqual(prepared.body);
  if (options.activate !== false) {
    expect((await bind('global-notes', account)).status).toBe(201);
    await queue.complete(run, { status: 'succeeded' });
  }
  const send = (
    delivery: string,
    source = `source-${delivery}`,
    extra: {
      path?: string;
      signature?: string;
      headers?: Record<string, string>;
      raw?: string;
      signal?: AbortSignal;
    } = {},
  ) =>
    app.app.request(extra.path ?? new URL(bound.body.url).pathname, {
      method: 'POST',
      headers: { 'x-fixture-signature': extra.signature ?? secret, ...extra.headers },
      body: extra.raw ?? JSON.stringify({ delivery, source }),
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
  return {
    app,
    hooks,
    workspace: workspace.id,
    keys,
    id,
    queue,
    run,
    token,
    account,
    secret,
    bound,
    bind,
    send,
    sourceAccountId: verified.body.sourceAccountId as string,
  };
}

describe('verified public ingress with real Postgres', () => {
  it('refuses disabled-runtime callbacks before verifier execution and accepts provider retries after restoration', async () => {
    const h = await setup();
    const paused = new Webhooks({
      sql: h.app.sql,
      catalog: new ExtensionCatalog([
        { manifest, actorCeiling: 'integration', runtimeEnabled: false },
      ]),
      broker,
      registry: new ExecutionRegistry(executables),
      driver,
      publicOrigin: 'http://retainer.test',
    });
    await expect(
      paused.receive(
        { route: 'notes', bindingId: h.bound.body.bindingId },
        new Request(h.bound.body.url, {
          method: 'POST',
          headers: { 'x-fixture-signature': h.secret },
          body: JSON.stringify({ delivery: 'paused', source: 'paused-note' }),
        }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'incompatible_runtime' });
    expect(seen).toHaveLength(0);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect((await h.send('paused', 'paused-note')).status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(1);
  });
  it('accepts exact raw bytes once under competing deliveries and stores only source IDs', async () => {
    const h = await setup();
    const raw = '{ "delivery": "same", "source": "provider-note-1" }';
    const responses = await Promise.all([
      h.send('same', undefined, {
        raw,
        headers: {
          authorization: `Bearer ${h.keys.admin}`,
          cookie: 'human-session=must-not-forward',
        },
      }),
      h.send('same', undefined, { raw }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    expect(Buffer.from(seen[0]?.rawBody ?? '', 'base64').toString()).toBe(raw);
    expect(seen[0]?.headers).toEqual({ 'x-fixture-signature': h.secret });
    expect(seen[0]).not.toHaveProperty('runToken');
    expect(seen[0]).not.toHaveProperty('workspaceId');
    const receipts =
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`;
    const jobs =
      await db.owner`select * from extension_jobs where installation_id=${h.id} and trigger_kind='job'`;
    expect(receipts).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0]?.input)).toEqual(['sourceItemId']);
    expect(JSON.stringify(receipts)).not.toContain('provider-note-1');
    expect(JSON.stringify(receipts)).not.toContain(h.secret);
    expect((await h.send('same', 'different-source')).status).toBe(409);
  });
  it('rejects signatures and oversize bodies, and rate-limits one source before invoking the verifier', async () => {
    const h = await setup({ rateLimit: 2 });
    expect((await h.send('large', undefined, { raw: 'x'.repeat(262145) })).status).toBe(413);
    expect((await h.send('bad', undefined, { signature: 'wrong' })).status).toBe(401);
    // Two requests and one failure from this source: both of its limits are spent.
    expect((await h.send('limited')).status).toBe(429);
    expect(seen).toHaveLength(1);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
  });
  it('counts only failed verifications against the durable budget, so junk from one source cannot block valid deliveries', async () => {
    const h = await setup({ rateLimit: 10 }),
      from = (ip: string) => ({ headers: { 'x-test-client-ip': ip } }),
      failures = async () =>
        (
          await db.owner`select count from webhook_request_counts where workspace_id=${h.workspace}`
        )[0]?.count ?? 0;
    // Valid deliveries beyond the budget are all accepted and never counted.
    for (let i = 0; i < 12; i++)
      expect((await h.send(`valid-${i}`, undefined, from(`192.0.2.${i}`))).status).toBe(202);
    expect(await failures()).toBe(0);
    // One source may fail once (a tenth of 10); its junk then stops in memory.
    const junk = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.send(`junk-${i}`, undefined, { signature: 'wrong', ...from('198.51.100.1') }),
      ),
    );
    expect(junk.filter((r) => r.status === 401)).toHaveLength(1);
    expect(junk.filter((r) => r.status === 429)).toHaveLength(4);
    expect(await failures()).toBe(1);
    // The provider's next delivery still verifies and is accepted.
    const before = seen.length;
    expect((await h.send('after-junk', undefined, from('192.0.2.1'))).status).toBe(202);
    expect(seen.length).toBe(before + 1);
    expect(await failures()).toBe(1);
  });
  it('refuses before verification once failures from many sources reach the durable budget', async () => {
    const h = await setup({ rateLimit: 2 }),
      from = (ip: string) => ({ headers: { 'x-test-client-ip': ip } });
    for (const ip of ['198.51.100.1', '198.51.100.2'])
      expect(
        (await h.send(`junk-${ip}`, undefined, { signature: 'wrong', ...from(ip) })).status,
      ).toBe(401);
    const before = seen.length;
    expect(
      (await h.send('junk-3', undefined, { signature: 'wrong', ...from('198.51.100.3') })).status,
    ).toBe(429);
    expect(seen.length).toBe(before);
    const [counted] =
      await db.owner`select count from webhook_request_counts where workspace_id=${h.workspace}`;
    expect(counted?.count).toBe(2);
  });
  it('permits only explicit challenges before activation and never acknowledges work before setup completes', async () => {
    const h = await setup({ activate: false });
    expect((await h.send('early')).status).toBe(503);
    verify = async () => ({
      status: 'challenge',
      body: 'provider-proof',
      contentType: 'text/plain',
    });
    const challenge = await h.send('challenge');
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe('provider-proof');
    expect(challenge.headers.get('content-type')).toContain('text/plain');
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    const global = await h.bind('global-notes', h.account);
    expect(global.status).toBe(201);
    expect(
      (await h.send('challenge', undefined, { path: new URL(global.body.url).pathname })).status,
    ).toBe(503);
  });
  it('rolls back reservation and enqueue when durable receipt persistence fails', async () => {
    const h = await setup();
    await db.owner.unsafe(
      `create function fail_receipt_fixture() returns trigger language plpgsql as $$ begin raise exception 'fixture persistence outage'; end $$`,
    );
    await db.owner.unsafe(
      `create trigger receipt_outage before insert on webhook_receipts for each row execute function fail_receipt_fixture()`,
    );
    try {
      expect((await h.send('outage')).status).toBe(503);
      expect(
        await db.owner`select * from source_items where workspace_id=${h.workspace}`,
      ).toHaveLength(0);
      expect(
        await db.owner`select * from extension_jobs where installation_id=${h.id} and trigger_kind='job'`,
      ).toHaveLength(0);
      expect(
        await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
      ).toHaveLength(0);
    } finally {
      await db.owner.unsafe('drop trigger receipt_outage on webhook_receipts');
      await db.owner.unsafe('drop function fail_receipt_fixture()');
    }
    expect((await h.send('outage')).status).toBe(202);
  });
  it('rechecks revocation after out-of-transaction verification and refuses a second workspace in verifier output', async () => {
    const h = await setup();
    let entered = () => {},
      releaseVerification = () => {};
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
    verify = async (...args) => {
      entered();
      await paused;
      return normal(...args);
    };
    const pending = h.send('in-flight');
    await started;
    try {
      expect(
        (
          await h.app.request(`/v1/extensions/${h.id}/disable`, {
            key: h.keys.admin,
            method: 'POST',
          })
        ).status,
      ).toBe(200);
    } finally {
      releaseVerification();
    }
    expect((await pending).status).toBe(410);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    verify = async () =>
      ({
        status: 'verified',
        deliveryId: 'forged',
        externalId: 'note',
        workspaceId: randomUUID(),
      }) as VerificationResult;
    const other = await setup();
    expect((await other.send('forged')).status).toBe(503);
  });
  it('treats global account hints as unauthenticated routing and rejects ambiguous account bindings', async () => {
    const a = await setup({ activate: false }),
      b = await setup({ activate: false });
    expect((await a.bind('global-notes', 'forged-account')).status).toBe(422);
    expect((await a.bind('global-notes', a.account)).status).toBe(201);
    expect((await b.bind('global-notes', b.account)).status).toBe(201);
    await a.queue.complete(a.run, { status: 'succeeded' });
    await b.queue.complete(b.run, { status: 'succeeded' });
    const path = `/extensions/hooks/${manifest.universalId}/global-notes`;
    expect(
      (await a.send('forged-hint', undefined, { path, headers: { 'provider-account': b.account } }))
        .status,
    ).toBe(401);
    expect(
      (
        await a.send('unknown-hint', undefined, {
          path,
          headers: { 'provider-account': 'not-connected' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await a.send('right-account', undefined, {
          path,
          headers: { 'provider-account': a.account },
        })
      ).status,
    ).toBe(202);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${b.workspace}`,
    ).toHaveLength(0);
    const duplicate = await setup({ account: a.account, activate: false });
    expect((await duplicate.bind('global-notes', a.account)).status).toBe(409);
  });
  it('rolls back a new source and receipt at queue capacity', async () => {
    const h = await setup();
    await db.owner`insert into extension_jobs(workspace_id,installation_id,generation,release_digest,function_id,input,input_hash,dedupe_key)
      select ${h.workspace}::uuid,${h.id}::uuid,${h.run.generation},${release.digest},${syncId}::uuid,'{}'::jsonb,'seed','seed-'||n from generate_series(1,10000) n`;
    const result = await h.send('queue-full');
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('60');
    expect(
      await db.owner`select * from source_items where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
  });
  it('times out an unresponsive verifier without acknowledging or persisting source work', async () => {
    const h = await setup();
    let observed: AbortSignal | undefined;
    verify = async (_executable, _invocation, signal) => {
      observed = signal;
      return new Promise(() => {});
    };
    expect((await h.send('hung-verifier')).status).toBe(503);
    expect(observed?.aborted).toBe(true);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select * from source_items where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
  });
  it('erases accepted receipts and rejects an in-flight or replayed forgotten source while unrelated notifications continue', async () => {
    const h = await setup();
    expect((await h.send('accepted-before-forget', 'pending-note')).status).toBe(202);
    const [job] =
      await db.owner`select id,source_item_id from extension_jobs where installation_id=${h.id} and trigger_kind='job'`;
    const run = await h.queue.claim(h.workspace, job?.id, 'pending-source');
    if (!run) throw new Error('source run missing');
    const token = await tokens.issue(h.app.sql, run, manifest.universalId, ['read', 'write']);
    const person = await h.app.request('/v1/objects/person/records', {
      key: h.keys.admin,
      body: { values: { name: 'Erase participant', emails: 'erase-hooks@fixture.test' } },
    });
    expect(person.status).toBe(201);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source-items/${job?.source_item_id}/prepare`, {
          key: token,
          body: { participants: ['erase-hooks@fixture.test'] },
        })
      ).status,
    ).toBe(200);
    let entered = () => {},
      resume = () => {};
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
    verify = async (...args) => {
      entered();
      await paused;
      return normal(...args);
    };
    const pending = h.send('during-forget', 'pending-note');
    await started;
    try {
      expect(
        (
          await h.app.request(`/v1/records/${person.body.id}/forget`, {
            key: h.keys.admin,
            method: 'POST',
          })
        ).status,
      ).toBe(200);
    } finally {
      resume();
    }
    expect((await pending).status).toBe(410);
    verify = normal;
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect((await h.send('replayed-after-forget', 'pending-note')).status).toBe(409);
    expect(
      await db.owner`select id from extension_jobs where installation_id=${h.id} and status in ('queued','running')`,
    ).toHaveLength(0);
    expect((await h.send('unrelated', 'surviving-note')).status).toBe(202);
  });
  it('gives an explicitly disconnected account a fresh callback and preserves old receipt dedupe', async () => {
    const h = await setup();
    expect((await h.send('old-delivery', 'old-note')).status).toBe(202);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/disconnect`, {
          key: h.keys.admin,
          body: {},
        })
      ).status,
    ).toBe(200);
    expect((await h.send('old-delivery', 'old-note')).status).toBe(404);
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/enable`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    const [pending] =
      await db.owner`select j.id from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation
      where j.installation_id=${h.id} and j.trigger_kind='install' and j.status='queued'`;
    const run = await h.queue.claim(h.workspace, pending?.id, 'reconnect');
    if (!run) throw new Error('reconnect setup missing');
    const token = await tokens.issue(h.app.sql, run, manifest.universalId, ['read', 'write']);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/verify`, {
          key: token,
          body: { accountId: 'replacement-provider-account', sharing: 'workspace' },
        })
      ).status,
    ).toBe(200);
    const rebound = await h.app.request(`/v1/extensions/${h.id}/runtime/webhooks`, {
      key: token,
      body: { route: 'notes' },
    });
    expect(rebound.status).toBe(201);
    expect(rebound.body.bindingId).not.toBe(h.bound.body.bindingId);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/runtime/webhooks`, {
          key: token,
          body: { route: 'global-notes', accountHint: 'replacement-provider-account' },
        })
      ).status,
    ).toBe(201);
    await h.queue.complete(run, { status: 'succeeded' });
    expect(
      (
        await h.send('old-delivery', 'new-account-note', {
          path: new URL(rebound.body.url).pathname,
        })
      ).status,
    ).toBe(202);
    expect((await h.send('late-old-account')).status).toBe(404);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(2);
    const accounts =
      await db.owner`select distinct account_id from source_items where workspace_id=${h.workspace}`;
    expect(accounts).toHaveLength(2);
  });
  it('reconnects through a reviewed plan, preserving the verified account unless replacement is explicitly approved', async () => {
    const h = await setup();
    const reconnect = async (replaceSourceAccount: boolean) => {
      const input = {
        installationId: h.id,
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
        reconnect: true,
        replaceSourceAccount,
      };
      const preview = await h.app.request('/v1/extensions/preview', {
        key: h.keys.admin,
        body: input,
      });
      expect(preview.status).toBe(200);
      const committed = await h.app.request(`/v1/extensions/${h.id}/reconnect`, {
        key: h.keys.admin,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': randomUUID() },
      });
      expect(committed.status).toBe(200);
      expect(committed.body.state).toBe('installing');
      const [job] =
        await db.owner`select j.id from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation where i.id=${h.id} and j.trigger_kind='install' and j.status='queued'`;
      const run = await h.queue.claim(h.workspace, job?.id, 'reconnect');
      if (!run) throw new Error('setup missing');
      const token = await tokens.issue(h.app.sql, run, manifest.universalId, ['read', 'write']);
      return { run, token };
    };
    const retained = await reconnect(false);
    expect((await h.send('during-setup')).status).toBe(404);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/verify`, {
          key: retained.token,
          body: { accountId: 'different-account', sharing: 'workspace' },
        })
      ).body.error.code,
    ).toBe('source_account_changed');
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/verify`, {
          key: retained.token,
          body: { accountId: h.account, sharing: 'workspace' },
        })
      ).status,
    ).toBe(200);
    const bind = async (token: string, route: string, accountHint?: string) =>
      h.app.request(`/v1/extensions/${h.id}/runtime/webhooks`, {
        key: token,
        body: { route, ...(accountHint ? { accountHint } : {}) },
      });
    expect((await bind(retained.token, 'notes')).body.bindingId).toBe(h.bound.body.bindingId);
    expect((await bind(retained.token, 'global-notes', h.account)).status).toBe(201);
    await h.queue.complete(retained.run, { status: 'succeeded' });
    expect((await h.send('same-account-reconnected')).status).toBe(202);
    const replaced = await reconnect(true);
    expect((await h.send('old-account-revoked')).status).toBe(404);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/verify`, {
          key: replaced.token,
          body: { accountId: 'new-account', sharing: 'workspace' },
        })
      ).status,
    ).toBe(200);
    const fresh = await bind(replaced.token, 'notes');
    expect(fresh.body.bindingId).not.toBe(h.bound.body.bindingId);
    expect((await bind(replaced.token, 'global-notes', 'new-account')).status).toBe(201);
    await h.queue.complete(replaced.run, { status: 'succeeded' });
    expect(
      (await h.send('new-account', undefined, { path: new URL(fresh.body.url).pathname })).status,
    ).toBe(202);
    expect((await h.send('old-still-revoked')).status).toBe(404);
  });
  it('reports a terminal provider credential failure as needing reconnect while preserving installed data', async () => {
    const h = await setup();
    expect((await h.send('auth-failure')).status).toBe(202);
    const [job] =
      await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='job' and status='queued'`;
    const run = await h.queue.claim(h.workspace, job?.id, 'provider-auth');
    if (!run) throw new Error('job missing');
    await h.queue.complete(run, { status: 'failed', code: 'provider_unauthorized' });
    const detail = await h.app.request(`/v1/extensions/${h.id}`, { key: h.keys.admin });
    expect(detail.body).toMatchObject({
      state: 'active',
      connectionHealth: 'needs_reconnect',
      lastError: 'provider_unauthorized',
    });
  });
  it('prunes seven-day receipts and retired callbacks through the bounded worker even without executable catalog entries', async () => {
    const h = await setup();
    expect((await h.send('old')).status).toBe(202);
    await db.owner`update webhook_receipts set created_at=clock_timestamp()-interval '8 days' where workspace_id=${h.workspace}`;
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/source/disconnect`, {
          key: h.keys.admin,
          body: {},
        })
      ).status,
    ).toBe(200);
    await db.owner`update webhook_bindings set updated_at=clock_timestamp()-interval '31 days' where installation_id=${h.id}`;
    const maintenance = new ChangeMaintenance(h.app.sql, db.connect({ role: 'retainer_executor' }));
    const result = await maintenance.tick();
    expect(result.failed).toBe(0);
    expect(result.pruned).toBeGreaterThanOrEqual(2);
    expect(
      await db.owner`select * from webhook_receipts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select * from webhook_bindings where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select * from webhook_request_counts where workspace_id=${h.workspace}`,
    ).toHaveLength(0);
  });
  it('requires complete operator verifier configuration and keeps the bearer out of metadata-only services', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const base = {
      DATABASE_URL: db.url,
      RETAINER_PUBLIC_ORIGIN: 'http://retainer.test',
      RETAINER_EXTENSION_ISSUER: 'https://retainer.test',
      RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(publicKey.export({ format: 'jwk' })),
      RETAINER_EXTENSION_CATALOG: JSON.stringify([
        { manifest, actorCeiling: 'integration', runtimeEnabled: true },
      ]),
      RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(executables),
      RETAINER_EXTENSION_SECRET_KEYS: JSON.stringify({
        currentVersion: 'fixture',
        keys: { fixture: randomBytes(32).toString('base64') },
      }),
    };
    await expect(extensionServices(loadConfig(base))).rejects.toThrow('configuration');
    const metadata = await extensionServices(
      loadConfig({ ...base, RETAINER_EXTENSION_VERIFIER_ORIGIN: 'http://launcher.test' }),
    );
    try {
      expect([...metadata.activationReady]).toEqual([release.digest]);
      expect(metadata.webhooks).toBeUndefined();
    } finally {
      await metadata.close();
    }
    const sql = db.connect({ role: 'retainer_app' }),
      options = { broker: true, ingressSql: sql };
    const configured = {
      ...base,
      RETAINER_EXTENSION_VERIFIER_ORIGIN: 'http://launcher.test',
      RETAINER_VERIFIER_TOKEN: 'v'.repeat(32),
    };
    await expect(
      extensionServices(loadConfig({ ...configured, RETAINER_VERIFIER_TOKEN: '' }), options),
    ).rejects.toThrow('configuration');
    await expect(
      extensionServices(
        loadConfig({ ...configured, RETAINER_LAUNCHER_TOKEN: 'v'.repeat(32) }),
        options,
      ),
    ).rejects.toThrow('configuration');
    const ready = await extensionServices(loadConfig(configured), options);
    try {
      expect(ready.webhooks).toBeDefined();
      expect([...ready.activationReady]).toEqual([release.digest]);
    } finally {
      await ready.close();
    }
  });
  it('requires a new public route when a release changes its account locator contract', () => {
    const next = extensionFixture({
      ...manifest,
      version: '1.0.1',
      webhooks: manifest.webhooks?.map((hook) =>
        hook.accountHeader
          ? {
              ...hook,
              accountHeader: 'another-account-header',
              headers: hook.headers.map((header) =>
                header === hook.accountHeader ? 'another-account-header' : header,
              ),
            }
          : hook,
      ),
    });
    expect(
      () =>
        new ExtensionCatalog([
          { manifest, actorCeiling: 'integration' },
          { manifest: next, actorCeiling: 'integration' },
        ]),
    ).toThrow('locator cannot change');
    expect(
      new ExtensionCatalog([
        { manifest, actorCeiling: 'integration' },
        {
          manifest: extensionFixture({ ...manifest, version: '1.0.1' }),
          actorCeiling: 'integration',
        },
      ]).list(),
    ).toHaveLength(2);
  });
  it('reserves one retry-stable callback before connection verification without granting source or CRM authority', async () => {
    const h = await setup({
      beforeVerify: async ({ app, id, token, workspace, secret, bindingId, url, admin }) => {
        const prepare = (key = token) =>
          app.request(`/v1/extensions/${id}/runtime/webhooks/prepare`, {
            key,
            body: { route: 'notes' },
          });
        const attempts = await Promise.all([prepare(), prepare()]);
        expect(attempts.map((result) => result.body.bindingId)).toEqual([bindingId, bindingId]);
        expect((await prepare(admin)).status).toBe(403);
        const ownMetadata = await app.request(`/v1/extensions/${id}`, { key: token });
        expect(ownMetadata.status).toBe(200);
        expect(ownMetadata.body.settings).toEqual({});
        expect(
          (await app.request('/v1/objects/person/query', { key: token, body: {} })).status,
        ).toBe(409);
        const [pending] =
          await db.owner`select state,source_account_id from webhook_bindings where id=${bindingId}`;
        expect(pending).toEqual({ state: 'pending', source_account_id: null });
        expect(
          (
            await app.request(`/v1/extensions/${id}/runtime/webhooks`, {
              key: token,
              body: { route: 'notes' },
            })
          ).body.error.code,
        ).toBe('source_connection_required');
        const send = () =>
          app.app.request(new URL(url).pathname, {
            method: 'POST',
            headers: { 'x-fixture-signature': secret },
            body: JSON.stringify({ delivery: 'before-setup', source: 'must-not-reserve' }),
          });
        expect((await send()).status).toBe(503); // No signing material yet; never permanently reject a provider retry.
        const stored = await app.request(`/v1/extensions/${id}/runtime/secrets/signing`, {
          key: token,
          method: 'PUT',
          body: { expectedRevision: null, value: secret },
        });
        expect(stored.status).toBe(200);
        expect((await send()).status).toBe(503);
        verify = async () => ({
          status: 'challenge',
          body: 'pending-connection-challenge',
          contentType: 'text/plain',
        });
        const challenge = await send();
        expect(challenge.status).toBe(200);
        expect(await challenge.text()).toBe('pending-connection-challenge');
        verify = normal;
        expect(
          await db.owner`select id from source_items where workspace_id=${workspace}`,
        ).toHaveLength(0);
        expect(
          await db.owner`select delivery_hash from webhook_receipts where workspace_id=${workspace}`,
        ).toHaveLength(0);
        // Let the rest of setup perform its normal first generated-secret write.
        await db.owner`delete from extension_secrets where installation_id=${id} and name='signing'`;
      },
    });
    expect((await h.send('after-setup')).status).toBe(202);
  });
  it('permits polling without optional callbacks, but refuses a configured callback left pending', async () => {
    const h = await setup({ activate: false, optionalHooks: true });
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/runtime/webhooks/retire`, {
          key: h.token,
          body: { route: 'notes' },
        })
      ).body.retired,
    ).toBe(1);
    expect((await h.queue.complete(h.run, { status: 'succeeded' })).activated).toBe(true);
    expect((await h.send('retired-polling-hook')).status).toBe(404);
    const pending = await setup({ activate: false, optionalHooks: true });
    expect(
      (
        await pending.app.request(`/v1/extensions/${pending.id}/runtime/webhooks/prepare`, {
          key: pending.token,
          body: { route: 'global-notes' },
        })
      ).status,
    ).toBe(201);
    expect((await pending.queue.complete(pending.run, { status: 'succeeded' })).activated).toBe(
      false,
    );
  });
  it('refuses activation when the setup verifier leaves a declared webhook unbound', async () => {
    const h = await setup({ activate: false });
    expect((await h.queue.complete(h.run, { status: 'succeeded' })).activated).toBe(false);
    const detail = await h.app.request(`/v1/extensions/${h.id}`, { key: h.keys.admin });
    expect(detail.body.state).toBe('setup_failed');
    expect(detail.body.lastError).toBe('webhook_binding_required');
  });
  it('requires live signing material before activation and permits a retried setup to replace retired generated material', async () => {
    const h = await setup({ activate: false });
    expect((await h.bind('global-notes', h.account)).status).toBe(201);
    await db.owner`update extension_secrets set delete_after=clock_timestamp()+interval '24 hours' where installation_id=${h.id} and name='signing'`;
    expect((await h.queue.complete(h.run, { status: 'succeeded' })).activated).toBe(false);
    expect(
      (await h.app.request(`/v1/extensions/${h.id}`, { key: h.keys.admin })).body.lastError,
    ).toBe('webhook_binding_required');
    const retry = await h.app.request(`/v1/extensions/${h.id}/runs/${h.run.jobId}/retry`, {
      key: h.keys.admin,
      body: {},
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(retry.status).toBe(200);
    const run = await h.queue.claim(h.workspace, h.run.jobId, 'retry-setup');
    if (!run) throw new Error('retry missing');
    const token = await tokens.issue(h.app.sql, run, manifest.universalId, ['read', 'write']);
    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/runtime/secrets/signing`, {
          key: token,
          method: 'PUT',
          body: { expectedRevision: 1, value: 'replacement-signing-material' },
        })
      ).status,
    ).toBe(200);
    expect((await h.queue.complete(run, { status: 'succeeded' })).activated).toBe(true);
    expect(
      (await h.send('recovered', undefined, { signature: 'replacement-signing-material' })).status,
    ).toBe(202);
  });
});
describe('in-memory ingress limiter', () => {
  it('limits requests and failures per source per window, releases successes and stays bounded', () => {
    const limiter = new IngressLimiter(3, 60000, 2);
    expect(limiter.failureLimit).toBe(1);
    expect(limiter.admit('a', 0)).toBe(true);
    expect(limiter.admit('a', 1)).toBe(false); // its one failure slot is in flight
    limiter.settle('a', false, 2);
    expect(limiter.admit('a', 3)).toBe(true);
    limiter.settle('a', true, 4);
    expect(limiter.admit('a', 5)).toBe(false); // failed once this window
    expect(limiter.admit('a', 60000)).toBe(true); // a new window
    limiter.settle('a', false, 60001);
    expect(limiter.admit('a', 60002)).toBe(true);
    limiter.settle('a', false, 60003);
    expect(limiter.admit('a', 60004)).toBe(true);
    limiter.settle('a', false, 60005);
    expect(limiter.admit('a', 60006)).toBe(false); // fourth request over a limit of 3
    expect(limiter.admit('b', 60007)).toBe(true);
    expect(limiter.admit('c', 60008)).toBe(true); // evicts the oldest source
    expect(limiter.admit('a', 60009)).toBe(true);
  });
});
