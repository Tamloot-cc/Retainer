import { randomBytes, randomUUID } from 'node:crypto';
import type { ExtensionManifest, InputSchema } from '@retainer/extension';
import { BASE_EVENT_TYPE_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { removeFromOrganization } from '../../src/accounts/people.js';
import { CONTROL_ROLE } from '../../src/config.js';
import { inWorkspace, lockSchemaShared } from '../../src/db/tx.js';
import { admitRun } from '../../src/extension-runtime/admission.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { Extensions } from '../../src/extensions/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import { sessionCaller, team } from '../helpers/people.js';

const db = useTestDatabase();
const disconnectId = randomUUID();
const connectId = randomUUID(),
  workId = randomUUID(),
  syncId = randomUUID(),
  pollId = randomUUID();
const fn = (
  universalId: string,
  name: string,
  trigger: ExtensionManifest['functions'][number]['trigger'],
  inputSchema: InputSchema = { type: 'object', additionalProperties: false },
) => ({
  universalId,
  name,
  description: 'Member fixture',
  handlerDigest: 'b'.repeat(64),
  trigger,
  inputSchema,
  timeoutSeconds: 120,
});
const manifest = extensionFixture({
  name: 'member-fixture',
  connection: 'member',
  scopes: ['read', 'write'],
  settings: {
    share: {
      type: 'boolean',
      label: 'Share',
      required: true,
      consent: true,
      secret: false,
      reconnect: false,
    },
    days: {
      type: 'number',
      label: 'Days',
      level: 'connection',
      required: true,
      secret: false,
      reconnect: false,
    },
    apiKey: {
      type: 'string',
      label: 'Key',
      level: 'connection',
      required: true,
      secret: true,
      reconnect: true,
    },
  },
  source: {
    provider: 'fixture',
    identity: 'account',
    verifyFunctionId: connectId,
    syncFunctionIds: [syncId],
    scanFunctionIds: [pollId],
    eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
    revisionOrder: 'integer',
  },
  functions: [
    fn(connectId, 'connect', { kind: 'connect' }),
    fn(disconnectId, 'disconnect', { kind: 'disconnect' }),
    fn(workId, 'work', { kind: 'job' }),
    fn(
      syncId,
      'sync',
      { kind: 'job' },
      {
        type: 'object',
        properties: { sourceItemId: { type: 'string', maxLength: 36 } },
        required: ['sourceItemId'],
        additionalProperties: false,
      },
    ),
    fn(
      pollId,
      'poll',
      { kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' },
      {
        type: 'object',
        properties: { scheduledAt: { type: 'string', maxLength: 24 } },
        required: ['scheduledAt'],
        additionalProperties: false,
      },
    ),
  ],
});
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
]);
let t: TestApp, tokens: RunTokens, broker: SecretBroker, brokerSql: ReturnType<typeof db.connect>;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  brokerSql = db.connect({ role: 'retainer_secret_broker', max: 5 });
  broker = new SecretBroker(
    brokerSql,
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
  t = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    extensionSecrets: broker,
    runTokens: tokens,
  });
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Members ${randomUUID()}` },
    {
      admin: {
        actor: { type: 'user', id: 'admin', name: 'Admin' },
        scopes: ['admin', 'schema:write', 'read', 'write'],
      },
      dana: { actor: { type: 'user', id: 'dana', name: 'Dana' }, scopes: ['read', 'write'] },
      eli: { actor: { type: 'user', id: 'eli', name: 'Eli' }, scopes: ['read', 'write'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin', 'read', 'write'] },
    },
  );
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings: { share: true },
  };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  const installed = await t.request('/v1/extensions', {
    key: keys.admin,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { ...input, planDigest: preview.body.planDigest },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    base = `/v1/extensions/${id}`,
    queue = new ExtensionQueue(t.sql, catalog.runtime);
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const lease = await queue.claim(workspace.id, job?.id, 'install');
  if (!lease) throw new Error('setup missing');
  expect((await queue.complete(lease, { status: 'succeeded' })).activated).toBe(true);
  return { workspace: workspace.id, id, base, keys, queue };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function connecting(h: Setup, key: string, value: string) {
  const staged = await t.request(`${h.base}/connections/secrets`, {
    key,
    body: { name: 'apiKey', value },
  });
  expect(staged.status).toBe(201);
  const created = await t.request(`${h.base}/connections`, {
    key,
    body: { settings: { days: 31 }, secretRefs: { apiKey: staged.body.pendingSecretId } },
  });
  expect(created.status).toBe(201);
  const cid = created.body.id as string;
  const [job] =
    await db.owner`select id from extension_jobs where connection_id=${cid} and trigger_kind='connect' and status='queued'`;
  const run = await h.queue.claim(h.workspace, job?.id, `connect-${cid}`);
  if (!run) throw new Error('connect lease missing');
  const token = await tokens.issue(t.sql, run, manifest.universalId, ['read', 'write']);
  return { cid, run, token };
}
async function activate(h: Setup, c: Awaited<ReturnType<typeof connecting>>, account: string) {
  const verified = await t.request(`${h.base}/source/verify`, {
    key: c.token,
    body: { accountId: account, sharing: 'workspace' },
  });
  expect(verified.status).toBe(200);
  const checkpoint = await t.request(`${h.base}/runtime/checkpoint`, {
    key: c.token,
    body: {
      children: [{ functionId: workId, input: {}, dedupeKey: 'work' }],
      kv: { key: 'cursor', expectedRevision: null, value: account },
    },
  });
  expect(checkpoint.status).toBe(200);
  await h.queue.complete(c.run, { status: 'succeeded' });
  return checkpoint.body.ids[0] as string;
}
async function work(h: Setup, id: string) {
  const run = await h.queue.claim(h.workspace, id, `work-${id}`);
  if (!run) throw new Error('work lease missing');
  return { run, token: await tokens.issue(t.sql, run, manifest.universalId, ['read', 'write']) };
}
describe('member connection API, broker and execution with real Postgres', () => {
  it('installs without member credentials and allows only people to connect their own credential', async () => {
    const h = await setup();
    expect(
      (
        await t.request(`${h.base}/connections`, {
          key: h.keys.agent,
          body: { settings: { days: 31 } },
        })
      ).status,
    ).toBe(403);
    const c = await connecting(h, h.keys.dana, 'dana-key');
    expect((await t.request(`${h.base}/runtime/secrets/apiKey`, { key: c.token })).body.value).toBe(
      'dana-key',
    );
    expect((await t.request(`${h.base}`, { key: c.token })).body.settings).toEqual({
      share: true,
      days: 31,
    });
    expect((await t.request('/v1/objects/person/query', { key: c.token, body: {} })).status).toBe(
      409,
    );
    await activate(h, c, 'dana-account');
    const other = await connecting(h, h.keys.eli, 'eli-key');
    await activate(h, other, 'eli-account');
    expect(
      (await t.request(`${h.base}/connections`, { key: h.keys.dana })).body.connections.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([c.cid]);
    expect(
      (await t.request(`${h.base}/connections`, { key: h.keys.admin })).body.connections,
    ).toHaveLength(2);
    expect(
      (await t.request(`${h.base}/connections`, { key: h.keys.agent })).body.connections,
    ).toHaveLength(0);
    expect(
      (await t.request(`${h.base}/connections/${c.cid}`, { key: h.keys.eli, method: 'DELETE' }))
        .status,
    ).toBe(404);
  });

  it('isolates secrets, KV, run inspection, budgets and integration attribution for two active members', async () => {
    const h = await setup(),
      a = await connecting(h, h.keys.dana, 'first-key'),
      b = await connecting(h, h.keys.eli, 'second-key');
    const first = await activate(h, a, 'first-account'),
      second = await activate(h, b, 'second-account');
    const [ra, rb] = await Promise.all([work(h, first), work(h, second)]);
    expect(
      (await t.request(`${h.base}/runtime/secrets/apiKey`, { key: ra.token })).body.value,
    ).toBe('first-key');
    expect(
      (await t.request(`${h.base}/runtime/secrets/apiKey`, { key: rb.token })).body.value,
    ).toBe('second-key');
    expect((await t.request(`${h.base}/runtime/kv/cursor`, { key: ra.token })).body.value).toBe(
      'first-account',
    );
    expect((await t.request(`${h.base}/runtime/kv/cursor`, { key: rb.token })).body.value).toBe(
      'second-account',
    );
    const record = await t.request('/v1/objects/person/records', {
      key: ra.token,
      body: { values: { name: 'Imported person' } },
    });
    expect(record.status).toBe(201);
    const [saved] = await db.owner`select created_by from records where id=${record.body.id}`;
    expect(saved?.created_by).toEqual({
      type: 'integration',
      id: h.id,
      name: "member-fixture (Dana's account)",
    });
    const runs = await t.request(`${h.base}/runs`, { key: h.keys.dana });
    expect(runs.body.runs.every((r: { connectionId: string }) => r.connectionId === a.cid)).toBe(
      true,
    );
    const [one, two] = await Promise.all([
      tokens.authenticate(t.sql, ra.token),
      tokens.authenticate(t.sql, rb.token),
    ]);
    const spend = (caller: typeof one) =>
      inWorkspace(t.sql, h.workspace, async (tx) => {
        await lockSchemaShared(tx, h.workspace);
        if (!caller.run) throw new Error('run missing');
        return admitRun(tx, h.workspace, caller.run, true);
      });
    // The record creation already spent one of Dana's sixty writes.
    await Promise.all(Array.from({ length: 59 }, () => spend(one)));
    await expect(spend(one)).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(spend(two)).resolves.toMatchObject({ actor: { type: 'integration', id: h.id } });
  });

  it('binds one source account across competing connects and a failed setup cannot fail its peer', async () => {
    const h = await setup(),
      a = await connecting(h, h.keys.dana, 'first'),
      b = await connecting(h, h.keys.eli, 'second');
    const results = await Promise.all(
      [a, b].map((c) =>
        t.request(`${h.base}/source/verify`, {
          key: c.token,
          body: { accountId: 'same-account', sharing: 'workspace' },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.code).toBe('source_account_in_use');
    const loser = results[0]?.status === 409 ? a : b,
      winner = loser === a ? b : a;
    await h.queue.complete(loser.run, { status: 'failed', code: 'provider_unauthorized' });
    await h.queue.complete(winner.run, { status: 'succeeded' });
    const list = (await t.request(`${h.base}/connections`, { key: h.keys.admin })).body.connections;
    expect(list.find((c: { id: string }) => c.id === winner.cid).state).toBe('active');
    expect(list.find((c: { id: string }) => c.id === loser.cid).state).toBe('setup_failed');
    expect((await t.request(h.base, { key: h.keys.admin })).body.state).toBe('active');
  });

  it('uses per-connection discovery and one schedule occurrence when scheduler ticks race', async () => {
    const h = await setup(),
      a = await connecting(h, h.keys.dana, 'first'),
      b = await connecting(h, h.keys.eli, 'second');
    const first = await activate(h, a, 'first-account'),
      second = await activate(h, b, 'second-account');
    expect(
      (await h.queue.discover(db.owner, 100))
        .filter((r) => r.workspace_id === h.workspace)
        .map((r) => r.job_id)
        .sort(),
    ).toEqual([first, second].sort());
    const ra = await work(h, first);
    expect((await h.queue.discover(db.owner, 100)).map((r) => r.job_id)).toContain(second);
    await h.queue.complete(ra.run, { status: 'succeeded' });
    await h.queue.scheduleTick(h.workspace, h.id);
    await db.owner`update extension_schedules set next_due_at=now()-interval '5 minutes' where installation_id=${h.id} and connection_id is not null`;
    const ticks = await Promise.all([
      h.queue.scheduleTick(h.workspace, h.id),
      h.queue.scheduleTick(h.workspace, h.id),
    ]);
    expect(ticks.reduce((n, r) => n + r.scheduled, 0)).toBe(2);
    expect(
      await db.owner`select connection_id from extension_jobs where installation_id=${h.id} and trigger_kind='schedule'`,
    ).toHaveLength(2);
  });

  it('recovery reads enumerate only the pinned scanner account, including unsynced reservations', async () => {
    const h = await setup(),
      a = await connecting(h, h.keys.dana, 'first'),
      b = await connecting(h, h.keys.eli, 'second');
    const first = await activate(h, a, 'first-account'),
      second = await activate(h, b, 'second-account');
    const aa = await work(h, first),
      bb = await work(h, second),
      items: string[] = [];
    for (const run of [aa, bb]) {
      const account = (await t.request(`${h.base}/source`, { key: run.token })).body
        .sourceAccountId;
      const reserved = await t.request(`${h.base}/source-items`, {
        key: run.token,
        body: { sourceAccountId: account, externalId: 'session' },
      });
      expect(reserved.status).toBe(201);
      items.push(reserved.body.sourceItemId);
      expect((await t.request(`${h.base}/source-items`, { key: run.token })).status).toBe(403);
      await h.queue.complete(run.run, { status: 'succeeded' });
    }
    await h.queue.scheduleTick(h.workspace, h.id);
    await db.owner`update extension_schedules set next_due_at=now()-interval '5 minutes' where installation_id=${h.id} and connection_id is not null`;
    await h.queue.scheduleTick(h.workspace, h.id);
    const [job] =
      await db.owner`select id from extension_jobs where connection_id=${a.cid} and trigger_kind='schedule'`;
    const scan = await work(h, job?.id);
    const result = await t.request(`${h.base}/source-items`, { key: scan.token });
    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([{ sourceItemId: items[0] }]);
    expect(JSON.stringify(result.body)).not.toContain('session');
    expect((await t.request(`${h.base}/source-items`, { key: h.keys.dana })).status).toBe(404);
  });

  it('erasure fences member content, clears source cursors and preserves peer credentials and durable work', async () => {
    const h = await setup(),
      a = await connecting(h, h.keys.dana, 'first'),
      b = await connecting(h, h.keys.eli, 'second');
    const first = await activate(h, a, 'first-account'),
      second = await activate(h, b, 'second-account'),
      r = await work(h, first);
    const source = (await t.request(`${h.base}/source`, { key: r.token })).body.sourceAccountId;
    const reserved = await t.request(`${h.base}/source-items`, {
      key: r.token,
      body: { sourceAccountId: source, externalId: 'forgotten-session' },
    });
    expect(reserved.status).toBe(201);
    const item = reserved.body.sourceItemId;
    const checkpoint = await t.request(`${h.base}/runtime/checkpoint`, {
      key: r.token,
      body: {
        children: [{ functionId: syncId, input: { sourceItemId: item }, dedupeKey: 'prepare' }],
      },
    });
    expect(checkpoint.status).toBe(200);
    await h.queue.complete(r.run, { status: 'succeeded' });
    const sync = await work(h, checkpoint.body.ids[0]);
    expect(
      (
        await t.request(`${h.base}/source-items/${item}/prepare`, {
          key: sync.token,
          body: { participants: ['forget-member@fixture.test'] },
        })
      ).status,
    ).toBe(200);
    const person = await t.request('/v1/objects/person/records', {
      key: h.keys.admin,
      body: { values: { name: 'Forget member', emails: 'forget-member@fixture.test' } },
    });
    expect(person.status).toBe(201);
    expect(
      (await t.request(`/v1/records/${person.body.id}/forget`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    expect(
      (await db.owner`select external_id,state from source_items where id=${item}`)[0],
    ).toMatchObject({ external_id: null, state: 'erased' });
    expect(await db.owner`select key from extension_kv where installation_id=${h.id}`).toHaveLength(
      0,
    );
    expect((await t.request(`${h.base}/runtime/kv/cursor`, { key: sync.token })).status).toBe(409);
    const peer = await work(h, second);
    expect(
      (await t.request(`${h.base}/runtime/secrets/apiKey`, { key: peer.token })).body.value,
    ).toBe('second');
    expect((await t.request(`${h.base}/source`, { key: peer.token })).status).toBe(200);
  });

  it('reconnect fences the previous generation and refuses a different provider account', async () => {
    const h = await setup(),
      c = await connecting(h, h.keys.dana, 'old-key'),
      id = await activate(h, c, 'original-account');
    const old = await work(h, id);
    const staged = await t.request(`${h.base}/connections/secrets`, {
      key: h.keys.dana,
      body: { connectionId: c.cid, name: 'apiKey', value: 'new-key' },
    });
    expect(staged.status).toBe(201);
    expect(
      (
        await t.request(`${h.base}/connections/${c.cid}/reconnect`, {
          key: h.keys.eli,
          body: {
            settings: { days: 31 },
            expectedGeneration: 1,
            secretRefs: { apiKey: staged.body.pendingSecretId },
          },
        })
      ).status,
    ).toBe(409);
    const response = await t.request(`${h.base}/connections/${c.cid}/reconnect`, {
      key: h.keys.dana,
      body: {
        settings: { days: 60 },
        expectedGeneration: 1,
        secretRefs: { apiKey: staged.body.pendingSecretId },
      },
    });
    expect(response.status).toBe(200);
    expect((await t.request(`${h.base}/runtime/kv/cursor`, { key: old.token })).status).toBe(409);
    const [job] =
      await db.owner`select id from extension_jobs where connection_id=${c.cid} and status='queued' and trigger_kind='connect'`;
    const next = await h.queue.claim(h.workspace, job?.id, 'reconnect');
    if (!next) throw new Error('reconnect lease missing');
    const token = await tokens.issue(t.sql, next, manifest.universalId, ['read', 'write']);
    expect((await t.request(`${h.base}/runtime/secrets/apiKey`, { key: token })).body.value).toBe(
      'new-key',
    );
    const changed = await t.request(`${h.base}/source/verify`, {
      key: token,
      body: { accountId: 'different-account', sharing: 'workspace' },
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('source_account_changed');
    expect((await t.request(`${h.base}/runtime/kv/cursor`, { key: token })).body.value).toBe(
      'original-account',
    );
  });

  it('enable restarts member setup and uninstall disconnects every member', async () => {
    const h = await setup(),
      c = await connecting(h, h.keys.dana, 'key');
    await activate(h, c, 'account');
    expect((await t.request(`${h.base}/disable`, { key: h.keys.admin, body: {} })).status).toBe(
      200,
    );
    expect((await t.request(`${h.base}/enable`, { key: h.keys.admin, body: {} })).status).toBe(200);
    const [job] =
      await db.owner`select j.id from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation where i.id=${h.id} and j.trigger_kind='install' and j.status='queued'`;
    const run = await h.queue.claim(h.workspace, job?.id, 'enable');
    if (!run) throw new Error('enable missing');
    await h.queue.complete(run, { status: 'succeeded' });
    expect(
      (await db.owner`select state from extension_connections where id=${c.cid}`)[0]?.state,
    ).toBe('connecting');
    expect(
      await db.owner`select id from extension_jobs where connection_id=${c.cid} and trigger_kind='connect' and status='queued'`,
    ).toHaveLength(1);
    expect((await t.request(`${h.base}/uninstall`, { key: h.keys.admin, body: {} })).status).toBe(
      200,
    );
    expect(
      (await db.owner`select state from extension_connections where id=${c.cid}`)[0]?.state,
    ).toBe('disconnected');
    expect(
      await db.owner`select name from extension_secrets where connection_id=${c.cid} and delete_after is null`,
    ).toHaveLength(0);
  });

  it('a real organization removal racing a connect leaves no live connection', async () => {
    const group = await team(db),
      control = db.connect({ role: CONTROL_ROLE, max: 2 });
    const admin = await sessionCaller(db, t.sql, group.owner, group.workspaceId),
      member = await sessionCaller(db, t.sql, group.dana, group.workspaceId);
    const extensions = new Extensions(
      t.sql,
      catalog,
      broker,
      new Set(catalog.list().map((r) => r.digest)),
    );
    const input = {
      registrationId: manifest.universalId,
      version: manifest.version,
      settings: { share: true },
    };
    const preview = await extensions.preview(admin, input),
      installed = await extensions.install(
        admin,
        { ...input, planDigest: preview.planDigest },
        randomUUID(),
      );
    const queue = new ExtensionQueue(t.sql, catalog.runtime);
    const [setup] =
      await db.owner`select id from extension_jobs where installation_id=${installed.id} and trigger_kind='install'`;
    const run = await queue.claim(group.workspaceId, setup?.id, 'accounts-install');
    if (!run) throw new Error('accounts setup missing');
    await queue.complete(run, { status: 'succeeded' });
    const staged = await extensions.connections.stage(member, installed.id, {
      name: 'apiKey',
      value: 'member-key',
    });
    const results = await Promise.allSettled([
      extensions.connections.connect(member, installed.id, {
        settings: { days: 31 },
        secretRefs: { apiKey: staged.pendingSecretId },
      }),
      removeFromOrganization(control, group.owner, group.organizationId, group.dana.id),
    ]);
    expect(results[1]?.status).toBe('fulfilled');
    expect(
      await db.owner`select id from extension_connections where installation_id=${installed.id} and owner_id=${group.dana.id} and state<>'disconnected'`,
    ).toHaveLength(0);
    expect(
      await db.owner`select s.name from extension_secrets s join extension_connections c on c.id=s.connection_id where c.installation_id=${installed.id} and s.delete_after is null`,
    ).toHaveLength(0);
  });

  it('runs a no-secret disconnect hook with no CRM access and retains the installation pin until cleanup finishes', async () => {
    const h = await setup(),
      c = await connecting(h, h.keys.dana, 'key');
    await activate(h, c, 'account');
    expect((await t.request(`${h.base}/uninstall`, { key: h.keys.admin, body: {} })).status).toBe(
      200,
    );
    const [system] =
      await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='uninstall' and status='queued'`;
    const closing = await h.queue.claim(h.workspace, system?.id, 'uninstall');
    if (!closing) throw new Error('uninstall missing');
    await h.queue.complete(closing, { status: 'succeeded' });
    expect(
      (await db.owner`select state from extension_installations where id=${h.id}`)[0]?.state,
    ).toBe('uninstalling');
    const [job] =
      await db.owner`select id from extension_jobs where connection_id=${c.cid} and trigger_kind='disconnect' and status='queued'`;
    const cleanup = await work(h, job?.id);
    expect(
      (await t.request(`${h.base}/runtime/secrets/apiKey`, { key: cleanup.token })).status,
    ).toBe(404);
    expect(
      (await t.request('/v1/objects/person/query', { key: cleanup.token, body: {} })).status,
    ).toBe(409);
    expect(
      (
        await t.request(`${h.base}/runtime/checkpoint`, {
          key: cleanup.token,
          body: { children: [] },
        })
      ).status,
    ).toBe(403);
    await h.queue.complete(cleanup.run, { status: 'succeeded' });
    expect(
      (await db.owner`select state from extension_installations where id=${h.id}`)[0]?.state,
    ).toBe('uninstalled');
  });

  it('disconnect drains an admitted broker read and fences old runs while retaining imported records', async () => {
    const h = await setup(),
      c = await connecting(h, h.keys.dana, 'private-key'),
      id = await activate(h, c, 'account'),
      r = await work(h, id);
    const caller = await tokens.authenticate(t.sql, r.token);
    if (!caller.run) throw new Error('run missing');
    const record = await t.request('/v1/objects/person/records', {
      key: r.token,
      body: { values: { name: 'Retained' } },
    });
    let entered = () => {},
      release = () => {},
      disconnected = false;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        release = resolve;
      });
    const reading = inWorkspace(brokerSql, h.workspace, async (tx) => {
      const [admission] =
        await tx`select retainer_admit_secret_run(${manifest.universalId}::uuid,${h.id}::uuid,${r.run.generation},${r.run.jobId}::uuid,${r.run.owner},${r.run.fence}::bigint,${r.run.releaseDigest},${r.run.functionId}::uuid,'apiKey',false,${c.cid}::uuid,${r.run.connectionGeneration ?? null}) as ok`;
      expect(admission?.ok).toBe(true);
      entered();
      await paused;
    });
    await started;
    const disconnect = t
      .request(`${h.base}/connections/${c.cid}`, { key: h.keys.dana, method: 'DELETE' })
      .then((result) => {
        disconnected = true;
        return result;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disconnected).toBe(false);
    } finally {
      release();
    }
    await reading;
    expect((await disconnect).status).toBe(200);
    expect(
      (
        await t.request('/v1/objects/person/records', {
          key: r.token,
          body: { values: { name: 'Fenced' } },
        })
      ).status,
    ).toBe(409);
    expect((await t.request(`/v1/records/${record.body.id}`, { key: h.keys.admin })).status).toBe(
      200,
    );
    await expect(
      broker.readRuntime(
        {
          workspaceId: h.workspace,
          installationId: h.id,
          registrationId: manifest.universalId,
          connectionId: c.cid,
          name: 'apiKey',
        },
        caller.run,
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
  });
});
