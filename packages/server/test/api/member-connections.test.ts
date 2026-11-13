import { randomBytes, randomUUID } from 'node:crypto';
import type { ExtensionManifest, InputSchema } from '@retainer/extension';
import { BASE_EVENT_TYPE_IDS, BASE_FIELD_IDS, BASE_OBJECT_IDS } from '@retainer/shared';
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
const taskFieldId = randomUUID();
const manifest = extensionFixture({
  schema: [
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.task,
      definition: {
        universalId: taskFieldId,
        name: 'memberTaskId',
        label: 'Member task ID',
        type: 'text',
        isUnique: true,
        isNullable: true,
      },
    },
  ],
  name: 'member-fixture',
  onSourceDelete: 'retract',
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
    tasks: {
      objectId: BASE_OBJECT_IDS.task,
      identityFieldId: taskFieldId,
      titleFieldId: '5f37aa96-fac8-4572-9647-6b0da5d6d0c8',
      statusFieldId: BASE_FIELD_IDS.taskStatus,
      personFieldId: '3d66fcfe-2e9c-4aeb-a88a-7d6b3c2194ba',
      statuses: { open: 'todo', done: 'done' },
    },
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
const upgradedManifest = extensionFixture({ ...manifest, version: '1.1.0' });
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  { manifest: upgradedManifest, actorCeiling: 'integration', runtimeEnabled: true },
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
      name: "Member-fixture (Dana's account)",
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

async function taskFixture() {
  const h = await setup(),
    c = await connecting(h, h.keys.dana, 'task-key');
  const parent = await work(h, await activate(h, c, 'task-account'));
  const account = (await t.request(`${h.base}/source`, { key: parent.token })).body.sourceAccountId;
  const item = (
    await t.request(`${h.base}/source-items`, {
      key: parent.token,
      body: { sourceAccountId: account, externalId: randomUUID() },
    })
  ).body.sourceItemId;
  const child = await t.request(`${h.base}/runtime/checkpoint`, {
    key: parent.token,
    body: {
      children: [{ functionId: syncId, input: { sourceItemId: item }, dedupeKey: 'task-sync' }],
    },
  });
  expect(child.status).toBe(200);
  await h.queue.complete(parent.run, { status: 'succeeded' });
  const sync = await work(h, child.body.ids[0]);
  const imported = await t.request(`${h.base}/source-events`, {
    key: sync.token,
    body: {
      sourceItemId: item,
      providerRevision: '1',
      expectedRevisionId: null,
      event: {
        type: BASE_EVENT_TYPE_IDS.conversation,
        occurredAt: '2026-01-01T12:00:00Z',
        title: 'Meeting',
        summary: 'a'.repeat(21000),
      },
    },
  });
  expect(imported.status).toBe(200);
  const revision = imported.body.revisionId;
  const tasks = async (values: unknown[], complete = true) => {
    const snapshot = await t.request(`${h.base}/source-items/${item}`, { key: sync.token });
    return t.request(`${h.base}/source-items/${item}/tasks`, {
      key: sync.token,
      body: {
        expectedRevisionId: revision,
        expectedTaskRevision: snapshot.body.taskWriteRevision,
        tasks: values,
        complete,
      },
    });
  };
  return { ...h, sync, item, revision, tasks, event: imported.body.eventId };
}
const managedTask = (externalId: string, title = 'Follow up') => ({
  externalId,
  title,
  status: 'open',
  contactEmails: [],
});
describe('managed source tasks with real Postgres', () => {
  it('serializes competing snapshots, is idempotent and keeps edited tasks permanently', async () => {
    const h = await taskFixture();
    const results = await Promise.all([
      h.tasks([managedTask('one'), managedTask('two')]),
      h.tasks([managedTask('one'), managedTask('two')]),
    ]);
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(results.reduce((sum, r) => sum + (r.body.applied ?? 0), 0)).toBe(2);
    const rows =
      await db.owner`select record_id,external_id from source_tasks where item_id=${h.item} order by external_id`;
    const edited = await t.request(`/v1/records/${rows[0]!.record_id}`, {
      key: h.keys.dana,
      method: 'PATCH',
      body: { values: { title: 'My edited task' } },
    });
    expect(edited.status).toBe(200);
    const removed = await h.tasks([]);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ detached: 1, removed: 1 });
    const kept = await t.request(`/v1/records/${rows[0]!.record_id}`, { key: h.keys.admin });
    expect(kept.status).toBe(200);
    expect(kept.body.fields.title).toBe('My edited task');
    expect(
      (await h.tasks([managedTask('one', 'Overwrite'), managedTask('two')])).body,
    ).toMatchObject({ applied: 1 });
    expect(
      (await db.owner`select state from source_tasks where record_id=${rows[0]!.record_id}`)[0]!
        .state,
    ).toBe('detached');
  });
  it('skips absence deletion for incomplete snapshots and never restores a locally deleted task', async () => {
    const h = await taskFixture();
    expect((await h.tasks([managedTask('one')])).status).toBe(200);
    expect((await h.tasks([], false)).body.removed).toBe(0);
    const [row] = await db.owner`select record_id from source_tasks where item_id=${h.item}`;
    expect(
      (await t.request(`/v1/records/${row!.record_id}`, { key: h.keys.dana, method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect((await h.tasks([managedTask('one')])).body.applied).toBe(0);
    expect(
      (await db.owner`select deleted_at from records where id=${row!.record_id}`)[0]!.deleted_at,
    ).not.toBeNull();
  });
  it('detaches under the same locks before source retraction and erases derived task copies on forget', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('one'), managedTask('two')]);
    const rows =
      await db.owner`select record_id from source_tasks where item_id=${h.item} order by external_id`;
    expect(
      (
        await t.request(`/v1/records/${rows[0]!.record_id}`, {
          key: h.keys.dana,
          method: 'PATCH',
          body: { values: { title: 'Keep this' } },
        })
      ).status,
    ).toBe(200);
    const removed = await t.request(`${h.base}/source-items/${h.item}/unavailable`, {
      key: h.sync.token,
      body: { status: 'deleted', evidence: 'definitive_lookup' },
    });
    expect(removed.status).toBe(200);
    const [binding] =
      await db.owner`select state from source_tasks where record_id=${rows[0]!.record_id}`;
    expect(binding!.state).toBe('detached');
    expect(
      (await t.request(`/v1/records/${h.event}/forget`, { key: h.keys.admin, body: {} })).status,
    ).toBe(200);
    expect(
      await db.owner`select id from records where id=any(${rows.map((r) => r.record_id)}::uuid[])`,
    ).toHaveLength(0);
    expect(
      await db.owner`select 1 from event_identity_tombstones where workspace_id=${h.workspace}`,
    ).toHaveLength(3);
  });
});

describe('managed task continuation and edit races', () => {
  it('commits bounded progress and resumes without repeating assertions', async () => {
    const h = await taskFixture(),
      values = Array.from({ length: 35 }, (_, i) => managedTask(`batch-${i}`));
    const first = await h.tasks(values);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ applied: 30, hasMore: true });
    const second = await h.tasks(values);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ applied: 5, hasMore: false });
    expect(second.body.checkpoint).toBeGreaterThan(first.body.checkpoint);
    const third = await h.tasks(values);
    expect(third.body).toMatchObject({
      applied: 0,
      hasMore: false,
      checkpoint: second.body.checkpoint,
    });
    expect(await db.owner`select id from source_tasks where item_id=${h.item}`).toHaveLength(35);
  });
  it('serializes a human edit against source removal and never silently loses the edit', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('race')]);
    const [binding] = await db.owner`select record_id from source_tasks where item_id=${h.item}`;
    const [edit, remove] = await Promise.all([
      t.request(`/v1/records/${binding!.record_id}`, {
        key: h.keys.dana,
        method: 'PATCH',
        body: { values: { title: 'My raced edit' } },
      }),
      h.tasks([]),
    ]);
    expect(remove.status).toBe(200);
    if (edit.status === 200) {
      const kept = await t.request(`/v1/records/${binding!.record_id}`, { key: h.keys.admin });
      expect(kept.status).toBe(200);
      expect(kept.body.fields.title).toBe('My raced edit');
    } else expect(edit.status).toBe(409);
  });
});

describe('managed task schema and identity safety', () => {
  it('resolves renamed fields by reviewed IDs and stops safely when an open status is removed', async () => {
    const h = await taskFixture();
    const renamed = await t.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [{ op: 'rename_field', object: 'task', field: 'title', name: 'action' }],
      },
    });
    expect(renamed.status).toBe(200);
    expect((await h.tasks([{ ...managedTask('renamed'), status: 'done' }])).body.applied).toBe(1);
    const schema = await t.request(`${h.base}/source-tasks/schema`, { key: h.sync.token });
    expect(schema.body.fields.title.name).toBe('action');
    const removed = await t.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [{ op: 'remove_option', object: 'task', field: 'status', value: 'todo' }],
      },
    });
    expect(removed.status).toBe(200);
    const result = await h.tasks([]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ bindingStatus: 'degraded', removed: 0 });
    expect(
      await db.owner`select id from source_tasks where item_id=${h.item} and state='synced'`,
    ).toHaveLength(1);
  });
  it('treats the provider ceiling of 500 tasks as incomplete even if marked complete', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('retained')]);
    const result = await h.tasks(
      Array.from({ length: 500 }, (_, i) => managedTask(`ceiling-${i}`)),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      applied: 30,
      removed: 0,
      hasMore: true,
      warnings: ['source_tasks_incomplete'],
    });
    expect(
      (
        await db.owner`select state from source_tasks where item_id=${h.item} and external_id='retained'`
      )[0]!.state,
    ).toBe('synced');
  });
  it('restores only a provider-removed task when it moves sessions, preserving its local ID', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('moved')]);
    const [prior] = await db.owner`select record_id from source_tasks where item_id=${h.item}`;
    await h.tasks([]);
    const account = (await t.request(`${h.base}/source`, { key: h.sync.token })).body
      .sourceAccountId;
    const item = (
      await t.request(`${h.base}/source-items`, {
        key: h.sync.token,
        body: { sourceAccountId: account, externalId: randomUUID() },
      })
    ).body.sourceItemId;
    const next = await t.request(`${h.base}/runtime/checkpoint`, {
      key: h.sync.token,
      body: {
        children: [{ functionId: syncId, input: { sourceItemId: item }, dedupeKey: 'moved-task' }],
      },
    });
    expect(next.status).toBe(200);
    await h.queue.complete(h.sync.run, { status: 'succeeded' });
    const sync = await work(h, next.body.ids[0]);
    const imported = await t.request(`${h.base}/source-events`, {
      key: sync.token,
      body: {
        sourceItemId: item,
        providerRevision: '1',
        expectedRevisionId: null,
        event: {
          type: BASE_EVENT_TYPE_IDS.conversation,
          title: 'New meeting',
          occurredAt: '2026-01-02T12:00:00Z',
        },
      },
    });
    expect(imported.status).toBe(200);
    const result = await t.request(`${h.base}/source-items/${item}/tasks`, {
      key: sync.token,
      body: {
        expectedRevisionId: imported.body.revisionId,
        expectedTaskRevision: 0,
        tasks: [managedTask('moved', 'Moved action')],
        complete: true,
      },
    });
    expect(result.status).toBe(200);
    const [binding] =
      await db.owner`select record_id,item_id,state from source_tasks where account_id=${account} and external_id='moved'`;
    expect(binding).toMatchObject({ record_id: prior!.record_id, item_id: item, state: 'synced' });
    const [oldItem] =
      await db.owner`select task_write_revision from source_items where id=${h.item}`;
    expect(oldItem!.task_write_revision).toBe(3);
  });
  it('suppresses a forgotten task identity without erasing its meeting', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('forgotten')]);
    const [task] = await db.owner`select record_id from source_tasks where item_id=${h.item}`;
    expect(
      (await t.request(`/v1/records/${task!.record_id}/forget`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    expect(await db.owner`select id from records where id=${h.event}`).toHaveLength(1);
    expect(await db.owner`select id from source_tasks where item_id=${h.item}`).toHaveLength(0);
    expect(
      await db.owner`select 1 from event_identity_tombstones where workspace_id=${h.workspace}`,
    ).toHaveLength(1);
  });
});

describe('managed task cascading deletion', () => {
  it('retracts evidence for events reached through ordinary cascade rules', async () => {
    const h = await taskFixture();
    await h.tasks([managedTask('cascade')]);
    const [task] = await db.owner`select record_id from source_tasks where item_id=${h.item}`;
    const schema = await t.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'conversation',
            field: {
              name: 'action',
              label: 'Action',
              type: 'relation',
              settings: { targetObject: 'task', inverseField: 'discussions', onDelete: 'cascade' },
            },
          },
        ],
      },
    });
    expect(schema.status).toBe(200);
    const event = await t.request('/v1/events', {
      key: h.keys.admin,
      body: {
        type: 'conversation',
        channel: 'test',
        occurredAt: '2026-01-02T12:00:00Z',
        title: 'Task discussion',
        fields: { action: task!.record_id },
      },
    });
    expect(event.status).toBe(201);
    const person = await t.request('/v1/objects/person/records', {
      key: h.keys.admin,
      body: { values: { name: 'Cascade person' } },
    });
    expect(person.status).toBe(201);
    const claim = await t.request(`/v1/records/${person.body.id}`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { values: { jobTitle: 'Evidence from discussion' }, source: event.body.id },
    });
    expect(claim.status).toBe(200);
    expect((await h.tasks([])).status).toBe(200);
    const assertions =
      await db.owner`select status from field_assertions where record_id=${person.body.id} and source_record_id=${event.body.id}`;
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.every((a) => a.status === 'retracted')).toBe(true);
  });
});

describe('managed task cascade conflicts', () => {
  async function linkedTasks() {
    const h = await taskFixture();
    await h.tasks([managedTask('parent'), managedTask('child')]);
    const rows =
      await db.owner`select record_id,external_id from source_tasks where item_id=${h.item}`;
    const parent = rows.find((r) => r.external_id === 'parent')!.record_id,
      child = rows.find((r) => r.external_id === 'child')!.record_id;
    const schema = await t.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'task',
            field: {
              name: 'parent',
              label: 'Parent',
              type: 'relation',
              settings: { targetObject: 'task', inverseField: 'children', onDelete: 'cascade' },
            },
          },
        ],
      },
    });
    expect(schema.status).toBe(200);
    expect(
      (
        await t.request(`/v1/records/${child}`, {
          key: h.sync.token,
          method: 'PATCH',
          body: { values: { parent } },
        })
      ).status,
    ).toBe(200);
    return { ...h, parent, child };
  }
  it('does not retry deletion of a task already removed by the same cascade', async () => {
    const h = await linkedTasks();
    const result = await h.tasks([]);
    expect(result.status).toBe(200);
    expect(
      await db.owner`select id from records where id=any(${[h.parent, h.child]}::uuid[]) and deleted_at is null`,
    ).toHaveLength(0);
  });
  it('fails closed if a custom cascade would remove an edited managed task', async () => {
    const h = await linkedTasks();
    expect(
      (
        await t.request(`/v1/records/${h.child}`, {
          key: h.keys.dana,
          method: 'PATCH',
          body: { values: { title: 'Keep the child' } },
        })
      ).status,
    ).toBe(200);
    const result = await h.tasks([]);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('source_task_delete_conflict');
    expect(
      await db.owner`select id from records where id=any(${[h.parent, h.child]}::uuid[]) and deleted_at is null`,
    ).toHaveLength(2);
  });
});

describe('managed task value validation', () => {
  it('enforces workspace-required fields instead of bypassing the normal create rules', async () => {
    const h = await taskFixture();
    const changed = await t.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'task',
            field: { name: 'approval', label: 'Approval', type: 'text', isNullable: false },
          },
        ],
      },
    });
    expect(changed.status).toBe(200);
    const result = await h.tasks([managedTask('requires-approval')]);
    expect(result.status).toBe(422);
    expect(result.body.error.details.errors).toContainEqual({
      field: 'approval',
      message: 'is required',
    });
    expect(await db.owner`select id from source_tasks where item_id=${h.item}`).toHaveLength(0);
  });
});

describe('member upgrade hook input', () => {
  it('passes the replaced release version from installation setup to each connect hook', async () => {
    const h = await setup(),
      c = await connecting(h, h.keys.dana, 'upgrade-key');
    await activate(h, c, 'upgrade-account');
    const input = {
      installationId: h.id,
      registrationId: manifest.universalId,
      version: upgradedManifest.version,
      settings: { share: true },
    };
    const plan = await t.request('/v1/extensions/preview', { key: h.keys.admin, body: input });
    expect(plan.status).toBe(200);
    const upgraded = await t.request(`${h.base}/upgrade`, {
      key: h.keys.admin,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { ...input, planDigest: plan.body.planDigest },
    });
    expect(upgraded.status).toBe(200);
    const [job] =
      await db.owner`select j.id,j.input from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation where i.id=${h.id} and j.trigger_kind='install' and j.status='queued'`;
    expect(job?.input).toEqual({ previousVersion: '1.0.0' });
    const run = await h.queue.claim(h.workspace, job?.id, 'upgrade-install');
    if (!run) throw new Error('upgrade setup missing');
    await h.queue.complete(run, { status: 'succeeded' });
    const [connection] =
      await db.owner`select j.input from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation where j.connection_id=${c.cid} and j.trigger_kind='connect' and j.status='queued'`;
    expect(connection?.input).toEqual({ previousVersion: '1.0.0' });
  });
});
