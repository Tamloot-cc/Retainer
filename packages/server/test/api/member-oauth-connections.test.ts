import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionManifest, InputSchema } from '@retainer/extension';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import {
  isPartialReleaseBlocking,
  isPartialReleaseJob,
} from '../../src/extension-runtime/lifecycle.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import type { ExtensionOAuthClients } from '../../src/extensions/oauth-clients.js';
import { parseOAuthClients } from '../../src/extensions/oauth-clients.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const connectId = randomUUID(),
  disconnectId = randomUUID(),
  workId = randomUUID();
const fn = (
  universalId: string,
  name: string,
  trigger: ExtensionManifest['functions'][number]['trigger'],
  secrets: string[],
  inputSchema: InputSchema = { type: 'object', additionalProperties: false },
) => ({
  universalId,
  name,
  description: 'OAuth fixture',
  handlerDigest: 'b'.repeat(64),
  trigger,
  inputSchema,
  timeoutSeconds: 60,
  secrets,
});
const generated = (label: string) => ({
  type: 'string' as const,
  label,
  level: 'connection' as const,
  secret: true,
  generated: true,
  required: false,
  reconnect: false,
});
const manifest = extensionFixture({
  name: 'oauth-fixture',
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
      default: 31,
    },
    apiKey: {
      type: 'string',
      label: 'Key',
      level: 'connection',
      required: false,
      secret: true,
      reconnect: true,
    },
    verifier: generated('Verifier'),
    code: generated('Code'),
    tokens: generated('Tokens'),
  },
  oauth: {
    verifierSetting: 'verifier',
    codeSetting: 'code',
    tokenSetting: 'tokens',
    keySetting: 'apiKey',
    revokeUrl: 'https://provider.test/settings/apps',
  },
  gettingStarted: { text: 'Nothing yet.', linkLabel: 'Open', url: 'https://provider.test' },
  functions: [
    fn(connectId, 'connect', { kind: 'connect' }, ['apiKey', 'verifier', 'code', 'tokens']),
    fn(disconnectId, 'disconnect', { kind: 'disconnect' }, ['tokens']),
    fn(workId, 'work', { kind: 'job' }, ['apiKey']),
  ],
});
// The same registration's next release, for release-change tests.
const nextManifest = extensionFixture({ ...manifest, version: '1.1.0' });
// A member release without OAuth: the tab and connect stay as they are.
const keyOnly = extensionFixture({
  name: 'key-fixture',
  connection: 'member',
  scopes: ['read'],
  settings: {
    apiKey: {
      type: 'string',
      label: 'Key',
      level: 'connection',
      required: true,
      secret: true,
      reconnect: true,
    },
  },
  functions: [fn(randomUUID(), 'connect', { kind: 'connect' }, ['apiKey'])],
});
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  { manifest: nextManifest, actorCeiling: 'integration', runtimeEnabled: true },
  { manifest: keyOnly, actorCeiling: 'integration', runtimeEnabled: true },
]);
const client = {
  clientId: 'retainer-client',
  clientSecret: 'client-secret',
  authorizationEndpoint: 'https://provider.test/oauth/start',
  tokenEndpoint: 'https://provider.test/oauth/token',
  apiOrigin: 'https://api.provider.test',
  scope: 'email',
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let t: TestApp,
  strict: TestApp,
  tokens: RunTokens,
  broker: SecretBroker,
  clients: ExtensionOAuthClients;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker', max: 5 }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
  clients = parseOAuthClients(
    JSON.stringify({ [manifest.universalId]: client }),
    catalog,
    'https://retainer.test',
  );
  const deps = {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    extensionSecrets: broker,
    runTokens: tokens,
  };
  t = startTestApp(db, { ...deps, extensionOAuthClients: clients });
  strict = startTestApp(db, {
    ...deps,
    extensionOAuthClients: parseOAuthClients(
      JSON.stringify({ [manifest.universalId]: { ...client, keyFallback: false } }),
      catalog,
      'https://retainer.test',
    ),
  });
});

async function setup(release: ExtensionManifest = manifest) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `OAuth ${randomUUID()}` },
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
    registrationId: release.universalId,
    version: release.version,
    settings: release === manifest ? { share: true } : {},
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
    queue = new ExtensionQueue(t.sql, catalog.runtime);
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const lease = await queue.claim(workspace.id, job?.id, 'install');
  if (!lease) throw new Error('setup missing');
  expect((await queue.complete(lease, { status: 'succeeded' })).activated).toBe(true);
  return { workspace: workspace.id, id, base: `/v1/extensions/${id}`, keys, queue };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function authorize(h: Setup, key: string, body: Record<string, unknown> = {}) {
  return t.request(`${h.base}/connections/authorize`, {
    key,
    body: { settings: { days: 31 }, ...body },
  });
}
async function complete(h: Setup, key: string, body: Record<string, unknown>) {
  return t.request(`${h.base}/connections/authorize/complete`, { key, body });
}
/** Authorizes, completes with a code and claims the queued connect job. */
async function connected(h: Setup, key: string, body: Record<string, unknown> = {}) {
  const started = await authorize(h, key, body);
  expect(started.status).toBe(201);
  const done = await complete(h, key, { state: started.body.state, code: `code-${randomUUID()}` });
  expect(done.status).toBe(200);
  const cid = done.body.id as string;
  return { cid, ...(await claimConnect(h, cid)) };
}
async function claimConnect(h: Setup, cid: string) {
  const [job] =
    await db.owner`select id from extension_jobs where connection_id=${cid} and trigger_kind='connect' and status='queued'`;
  const run = await h.queue.claim(h.workspace, job?.id, `connect-${randomUUID()}`);
  if (!run) throw new Error('connect lease missing');
  return { run, token: await tokens.issue(t.sql, run, manifest.universalId, ['read', 'write']) };
}
async function claim(h: Setup, jobId: string | undefined) {
  const run = await h.queue.claim(h.workspace, jobId as string, `run-${randomUUID()}`);
  if (!run) return null;
  return { run, token: await tokens.issue(t.sql, run, manifest.universalId, ['read', 'write']) };
}
const partialJobs = (cid: string) =>
  db.owner<
    { id: string; status: string; code: string | null; expires_at: Date; input: unknown }[]
  >`select id,status,code,expires_at,input from extension_jobs where connection_id=${cid}
    and retainer_partial_release_job(trigger_kind,input) order by created_at`;
const connectionRow = async (cid: string) =>
  (
    await db.owner`select state,health,last_error,generation,credential,authorization_started_at,
      release_incidents,release_incomplete_at::text as release_incomplete_at,release_notice_dismissed_at
      from extension_connections where id=${cid}`
  )[0];
/** A connected OAuth connection whose setup then failed, with its partial job queued. */
async function failedConnect(h: Setup, key: string) {
  const c = await connected(h, key);
  const stored = await t.request(`${h.base}/runtime/secrets/tokens`, {
    key: c.token,
    method: 'PUT',
    body: { expectedRevision: null, value: '{"current":null}' },
  });
  expect(stored.status).toBe(200);
  await h.queue.complete(c.run, { status: 'failed', code: 'source_account_changed' });
  const [job] = await partialJobs(c.cid);
  if (!job) throw new Error('partial job missing');
  return { ...c, job };
}

describe('starting and completing an OAuth connection', () => {
  it('builds the authorize address, keeps the verifier server-side and starts the connect', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana, { loginHint: 'dana@example.com' });
    expect(started.status).toBe(201);
    const url = new URL(started.body.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(client.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: 'https://retainer.test/app/connect/callback',
      state: started.body.state,
      code_challenge_method: 'S256',
      scope: 'email',
      login_hint: 'dana@example.com',
    });
    expect(started.body.state).toMatch(
      new RegExp(`^v1\\.${h.workspace}\\.${h.id}\\.[A-Za-z0-9_-]{43}$`),
    );
    const [request] =
      await db.owner`select state_hash,connection_id,consumed_at from extension_authorizations where installation_id=${h.id}`;
    expect(request?.state_hash).toBe(sha256(started.body.state));
    expect(JSON.stringify(request)).not.toContain(started.body.state);
    const done = await complete(h, h.keys.dana, { state: started.body.state, code: 'the-code' });
    expect(done.body).toEqual({ id: request?.connection_id, state: 'connecting' });
    const row = await connectionRow(done.body.id);
    expect(row?.credential).toBe('oauth');
    expect(row?.authorization_started_at).toBeInstanceOf(Date);
    const { token } = await claimConnect(h, done.body.id);
    const verifier = await t.request(`${h.base}/runtime/secrets/verifier`, { key: token });
    expect(
      createHash('sha256').update(verifier.body.value).digest('base64url') ===
        url.searchParams.get('code_challenge'),
    ).toBe(true);
    expect((await t.request(`${h.base}/runtime/secrets/code`, { key: token })).body.value).toBe(
      'the-code',
    );
    const oauthClient = await t.request(`${h.base}/runtime/oauth-client`, { key: token });
    expect(oauthClient.status).toBe(200);
    expect(oauthClient.headers.get('cache-control')).toBe('no-store');
    expect(oauthClient.body).toEqual({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: client.tokenEndpoint,
      redirectUri: 'https://retainer.test/app/connect/callback',
      apiOrigin: client.apiOrigin,
    });
    const listed = await t.request(`${h.base}/connections`, { key: h.keys.dana });
    expect(listed.body.connections[0]).toMatchObject({
      credential: 'oauth',
      hasImportedItems: false,
      releaseIncompleteAt: null,
    });
    const read = await t.request(h.base, { key: h.keys.dana });
    expect(read.body.connectionMethods).toEqual(['oauth', 'key']);
    expect(read.body.releaseNotice).toBeNull();
  });

  it('refuses a replay, a tampered state and another member with the same answer', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    const state = started.body.state as string;
    const [, ws, inst, nonce] = state.split('.');
    const other = await setup();
    const variants = [
      `v1.${randomUUID()}.${inst}.${nonce}`,
      `v1.${ws}.${randomUUID()}.${nonce}`,
      `v1.${ws}.${other.id}.${nonce}`,
      `v1.${ws}.${inst}.${'A'.repeat(43)}`,
      'not-a-state',
      `v2.${ws}.${inst}.${nonce}`,
    ];
    const answers = [];
    for (const s of variants) answers.push(await complete(h, h.keys.dana, { state: s, code: 'x' }));
    answers.push(await complete(h, h.keys.eli, { state, code: 'x' }));
    for (const answer of answers) {
      expect(answer.status).toBe(409);
      expect(answer.body.error.code).toBe('authorization_expired');
    }
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    expect((await complete(h, h.keys.dana, { state, code: 'x' })).status).toBe(200);
    const replay = await complete(h, h.keys.dana, { state, code: 'x' });
    expect(replay.body).toEqual(answers[0]?.body);
    // A caller who is not a member of the named workspace gets the middleware's refusal.
    const outsider = await complete(other, other.keys.dana, { state, code: 'x' });
    expect(outsider.status).toBe(409);
  });

  it('expires a request after its lifetime and refuses a malformed body', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    await db.owner`update extension_authorizations set expires_at=clock_timestamp()-interval '1 second' where installation_id=${h.id}`;
    const late = await complete(h, h.keys.dana, { state: started.body.state, code: 'x' });
    expect(late.body.error.code).toBe('authorization_expired');
    expect(
      (await complete(h, h.keys.dana, { state: started.body.state, code: 'x', error: 'y' }))
        .status,
    ).toBe(400);
    expect((await complete(h, h.keys.dana, { state: started.body.state })).status).toBe(400);
    expect((await authorize(h, h.keys.dana, { loginHint: 'not-an-email' })).status).toBe(400);
  });

  it('a decline leaves nothing connected and the code then loses', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    const declined = await complete(h, h.keys.dana, {
      state: started.body.state,
      error: 'access_denied',
    });
    expect(declined.body).toEqual({ cancelled: true });
    expect(
      (await complete(h, h.keys.dana, { state: started.body.state, code: 'x' })).body.error.code,
    ).toBe('authorization_expired');
    expect(
      (await complete(h, h.keys.dana, { state: started.body.state, error: 'access_denied' })).body
        .error.code,
    ).toBe('authorization_expired');
    expect(await db.owner`select 1 from extension_connections where installation_id=${h.id}`).toEqual(
      [],
    );
  });

  it('refuses agents, a second connection, a key reconnect of OAuth and a stale generation', async () => {
    const h = await setup();
    expect((await authorize(h, h.keys.agent)).status).toBe(403);
    const c = await connected(h, h.keys.dana);
    expect((await authorize(h, h.keys.dana)).body.error.code).toBe('connection_exists');
    const [row] = await db.owner`select generation from extension_connections where id=${c.cid}`;
    expect(
      (await authorize(h, h.keys.dana, { connectionId: c.cid, expectedGeneration: 99 })).body.error
        .code,
    ).toBe('stale_plan');
    expect(
      (
        await authorize(h, h.keys.eli, {
          connectionId: c.cid,
          expectedGeneration: row?.generation,
        })
      ).status,
    ).toBe(404);
    const staged = await t.request(`${h.base}/connections/secrets`, {
      key: h.keys.dana,
      body: { name: 'apiKey', value: 'k', connectionId: c.cid },
    });
    const keyReconnect = await t.request(`${h.base}/connections/${c.cid}/reconnect`, {
      key: h.keys.dana,
      body: {
        settings: { days: 31 },
        secretRefs: { apiKey: staged.body.pendingSecretId },
        expectedGeneration: row?.generation,
      },
    });
    expect(keyReconnect.body.error.code).toBe('credential_mismatch');
    // Handshake material is server-staged only.
    expect(
      (
        await t.request(`${h.base}/connections/secrets`, {
          key: h.keys.dana,
          body: { name: 'code', value: 'planted' },
        })
      ).status,
    ).toBe(422);
  });

  it('refuses an OAuth reconnect of a key connection, and a key connect when keys are off', async () => {
    const h = await setup();
    const staged = await t.request(`${h.base}/connections/secrets`, {
      key: h.keys.dana,
      body: { name: 'apiKey', value: 'k' },
    });
    const keyed = await t.request(`${h.base}/connections`, {
      key: h.keys.dana,
      body: { settings: { days: 31 }, secretRefs: { apiKey: staged.body.pendingSecretId } },
    });
    expect(keyed.status).toBe(201);
    expect((await connectionRow(keyed.body.id))?.credential).toBe('key');
    expect(
      (await authorize(h, h.keys.dana, { connectionId: keyed.body.id, expectedGeneration: 1 }))
        .body.error.code,
    ).toBe('credential_mismatch');
    const again = await strict.request(`${h.base}/connections/secrets`, {
      key: h.keys.eli,
      body: { name: 'apiKey', value: 'k' },
    });
    const refused = await strict.request(`${h.base}/connections`, {
      key: h.keys.eli,
      body: { settings: { days: 31 }, secretRefs: { apiKey: again.body.pendingSecretId } },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invalid_connection');
    expect((await strict.request(h.base, { key: h.keys.eli })).body.connectionMethods).toEqual([
      'oauth',
    ]);
  });

  it('is unavailable without a client, and the key-only release reads as today', async () => {
    const h = await setup(keyOnly);
    expect((await authorize(h, h.keys.dana, { settings: {} })).body.error.code).toBe(
      'oauth_unavailable',
    );
    expect((await t.request(h.base, { key: h.keys.dana })).body.connectionMethods).toEqual([
      'key',
    ]);
  });

  it('a second start replaces the first request', async () => {
    const h = await setup();
    const first = await authorize(h, h.keys.dana);
    const second = await authorize(h, h.keys.dana);
    expect(
      (await complete(h, h.keys.dana, { state: first.body.state, code: 'x' })).body.error.code,
    ).toBe('authorization_expired');
    expect((await complete(h, h.keys.dana, { state: second.body.state, code: 'x' })).status).toBe(
      200,
    );
  });

  it('two completions of one state at once give one connection and one 409', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    const answers = await Promise.all([
      complete(h, h.keys.dana, { state: started.body.state, code: 'a' }),
      complete(h, h.keys.dana, { state: started.body.state, code: 'b' }),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(
      await db.owner`select id from extension_connections where installation_id=${h.id}`,
    ).toHaveLength(1);
  });

  it('a decline and a code at once never both succeed', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    const [code, decline] = await Promise.all([
      complete(h, h.keys.dana, { state: started.body.state, code: 'a' }),
      complete(h, h.keys.dana, { state: started.body.state, error: 'access_denied' }),
    ]);
    expect([code.status, decline.status].sort()).toEqual([200, 409]);
    const rows = await db.owner`select id from extension_connections where installation_id=${h.id}`;
    expect(rows).toHaveLength(code.status === 200 ? 1 : 0);
  });

  it('a completion waiting for the queue lock past the expiry loses', async () => {
    const h = await setup();
    const started = await authorize(h, h.keys.dana);
    await db.owner`update extension_authorizations set expires_at=clock_timestamp()+interval '300 milliseconds' where installation_id=${h.id}`;
    let release = () => {},
      locked = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = inWorkspace(db.connect({ role: 'retainer_app', max: 1 }), h.workspace, async (tx) => {
      await tx`select pg_advisory_xact_lock(21062::int4, hashtext(${`${h.workspace}:${h.id}`}))`;
      locked();
      await held;
    });
    await acquired;
    const answers = Promise.all([
      complete(h, h.keys.dana, { state: started.body.state, code: 'a' }),
      complete(h, h.keys.dana, { state: started.body.state, error: 'access_denied' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    await holding;
    for (const answer of await answers) expect(answer.body.error?.code).toBe('authorization_expired');
  });
});

describe('the OAuth client route', () => {
  it('refuses a non-run caller and a function that does not hold the token secret', async () => {
    const h = await setup();
    expect((await t.request(`${h.base}/runtime/oauth-client`, { key: h.keys.admin })).status).toBe(
      403,
    );
    const c = await connected(h, h.keys.dana);
    await h.queue.complete(c.run, { status: 'succeeded' });
    const [conn] = await db.owner`select generation from extension_connections where id=${c.cid}`;
    const [inst] =
      await db.owner`select generation,release_digest,workspace_id from extension_installations where id=${h.id}`;
    const jobId = randomUUID();
    await db.owner`insert into extension_jobs(id,workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,
      function_id,input,input_hash,dedupe_key,cause,trigger_kind)
      values(${jobId},${inst?.workspace_id},${h.id},${c.cid},${conn?.generation},${inst?.generation},${inst?.release_digest},
      ${workId},'{}','x','work','[]','job')`;
    const work = await claim(h, jobId);
    if (!work) throw new Error('work missing');
    expect((await t.request(`${h.base}/runtime/oauth-client`, { key: work.token })).status).toBe(
      403,
    );
    expect((await t.request(`${h.base}/runtime/secrets/tokens`, { key: work.token })).status).toBe(
      404,
    );
  });
});

describe('disconnect hooks read their declared secrets', () => {
  it('reads the token secret for 24 hours, never writes it, and retires it when it finishes', async () => {
    const h = await setup();
    const c = await connected(h, h.keys.dana);
    await t.request(`${h.base}/runtime/secrets/tokens`, {
      key: c.token,
      method: 'PUT',
      body: { expectedRevision: null, value: 'session' },
    });
    await h.queue.complete(c.run, { status: 'succeeded' });
    expect(
      (await t.request(`${h.base}/connections/${c.cid}`, { key: h.keys.dana, method: 'DELETE' }))
        .status,
    ).toBe(200);
    const secrets =
      await db.owner`select name,delete_after>clock_timestamp()+interval '23 hours' as kept from extension_secrets where connection_id=${c.cid} order by name`;
    expect(secrets.map((s) => [s.name, s.kept])).toEqual([
      ['code', false],
      ['tokens', true],
      ['verifier', false],
    ]);
    const listed = await t.request(`${h.base}/connections`, { key: h.keys.dana });
    expect(listed.body.connections[0].secrets).toEqual([]);
    const [job] =
      await db.owner`select id from extension_jobs where connection_id=${c.cid} and trigger_kind='disconnect' and status='queued'`;
    const hook = await claim(h, job?.id);
    if (!hook) throw new Error('hook missing');
    expect(
      (await t.request(`${h.base}/runtime/secrets/tokens`, { key: hook.token })).body.value,
    ).toBe('session');
    expect((await t.request(`${h.base}/runtime/oauth-client`, { key: hook.token })).status).toBe(
      200,
    );
    expect(
      (
        await t.request(`${h.base}/runtime/secrets/tokens`, {
          key: hook.token,
          method: 'PUT',
          body: { expectedRevision: 1, value: 'other' },
        })
      ).status,
    ).toBe(409);
    expect((await t.request(`${h.base}/runtime/secrets/code`, { key: hook.token })).status).toBe(
      404,
    );
    expect(
      (await t.request('/v1/objects/person/query', { key: hook.token, body: {} })).status,
    ).toBe(409);
    await h.queue.complete(hook.run, { status: 'succeeded' });
    const [left] =
      await db.owner`select delete_after<=clock_timestamp() as retired from extension_secrets where connection_id=${c.cid} and name='tokens'`;
    expect(left?.retired).toBe(true);
    expect((await connectionRow(c.cid))?.release_incidents).toEqual([]);
  });

  it('a hook that fails for good records its own incident and retires the secret', async () => {
    const h = await setup();
    const c = await connected(h, h.keys.dana);
    await h.queue.complete(c.run, { status: 'succeeded' });
    await t.request(`${h.base}/connections/${c.cid}`, { key: h.keys.dana, method: 'DELETE' });
    const [job] =
      await db.owner`select id from extension_jobs where connection_id=${c.cid} and trigger_kind='disconnect' and status='queued'`;
    const hook = await claim(h, job?.id);
    if (!hook) throw new Error('hook missing');
    await h.queue.complete(hook.run, { status: 'failed', code: 'release_incomplete' });
    const row = await connectionRow(c.cid);
    expect(row?.release_incidents).toEqual([`cleanup:${job?.id}`]);
    expect(row?.release_incomplete_at).not.toBeNull();
    const listed = await t.request(`${h.base}/connections`, { key: h.keys.admin });
    expect(listed.body.connections[0].releaseIncompleteAt).not.toBeNull();
  });
});

describe('partial release jobs', () => {
  it('a failed connect queues the keep-current hook, which reads and never writes, with no CRM access', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    expect(f.job.input).toEqual({ keep: 'current' });
    expect(f.job.expires_at.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    const hook = await claim(h, f.job.id);
    if (!hook) throw new Error('partial job not claimed');
    expect(
      (await t.request(`${h.base}/runtime/secrets/tokens`, { key: hook.token })).body.value,
    ).toBe('{"current":null}');
    expect(
      (
        await t.request(`${h.base}/runtime/secrets/tokens`, {
          key: hook.token,
          method: 'PUT',
          body: { expectedRevision: 1, value: 'x' },
        })
      ).status,
    ).toBe(409);
    expect((await t.request(`${h.base}/runtime/oauth-client`, { key: hook.token })).status).toBe(
      200,
    );
    expect((await t.request(h.base, { key: hook.token })).status).toBe(200);
    expect(
      (await t.request('/v1/objects/person/query', { key: hook.token, body: {} })).status,
    ).toBe(409);
    expect(
      (
        await t.request(`${h.base}/runtime/checkpoint`, {
          key: hook.token,
          body: { children: [] },
        })
      ).status,
    ).toBe(403);
    const before = await connectionRow(f.cid);
    await h.queue.complete(hook.run, { status: 'succeeded' });
    const after = await connectionRow(f.cid);
    expect(after).toEqual(before);
    expect(after?.last_error).toBe('source_account_changed');
    const [kept] =
      await db.owner`select delete_after from extension_secrets where connection_id=${f.cid} and name='tokens'`;
    expect(kept?.delete_after).toBeNull();
    expect(
      await db.owner`select 1 from extension_jobs where connection_id=${f.cid} and status='queued'`,
    ).toEqual([]);
  });

  it('a needs-reconnect failure queues it too, and only once per generation', async () => {
    const h = await setup();
    const c = await connected(h, h.keys.dana);
    await h.queue.complete(c.run, { status: 'succeeded' });
    const [conn] = await db.owner`select generation from extension_connections where id=${c.cid}`;
    const [inst] =
      await db.owner`select generation,release_digest,workspace_id from extension_installations where id=${h.id}`;
    const jobId = randomUUID();
    await db.owner`insert into extension_jobs(id,workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,
      function_id,input,input_hash,dedupe_key,cause,trigger_kind)
      values(${jobId},${inst?.workspace_id},${h.id},${c.cid},${conn?.generation},${inst?.generation},${inst?.release_digest},
      ${workId},'{}','x','work','[]','job')`;
    const work = await claim(h, jobId);
    if (!work) throw new Error('work missing');
    await h.queue.complete(work.run, { status: 'failed', code: 'provider_unauthorized' });
    expect((await connectionRow(c.cid))?.state).toBe('needs_reconnect');
    expect(await partialJobs(c.cid)).toHaveLength(1);
  });

  it('is not claimed past its deadline; the sweep fails it, records the incident and changes nothing else', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const before = await connectionRow(f.cid);
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${f.job.id}`;
    const due = await db.owner`select * from retainer_extension_jobs_due(100,${[manifest.universalId]}::uuid[],${[catalog.get(manifest.universalId, manifest.version).digest]}::text[]) where job_id=${f.job.id}`;
    expect(due).toEqual([]);
    await h.queue.maintain(db.connect({ role: 'retainer_executor', max: 1 }));
    const [job] = await partialJobs(f.cid);
    expect([job?.status, job?.code]).toEqual(['failed', 'cleanup_deadline_expired']);
    const after = await connectionRow(f.cid);
    expect(after?.release_incidents).toEqual([`cleanup:${f.job.id}`]);
    expect([after?.state, after?.health, after?.last_error, after?.generation]).toEqual([
      before?.state,
      before?.health,
      before?.last_error,
      before?.generation,
    ]);
    const [kept] =
      await db.owner`select delete_after from extension_secrets where connection_id=${f.cid} and name='tokens'`;
    expect(kept?.delete_after).toBeNull();
    const read = await t.request(h.base, { key: h.keys.dana });
    expect(read.body.releaseNotice).toEqual({ connectionId: f.cid, at: after?.release_incomplete_at });
  });

  it('an open handshake defers it; starting a reconnect while it runs is refused', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const generation = (await connectionRow(f.cid))?.generation;
    const started = await authorize(h, h.keys.dana, {
      connectionId: f.cid,
      expectedGeneration: generation,
    });
    expect(started.status).toBe(201);
    expect(await claim(h, f.job.id)).toBeNull();
    const declined = await complete(h, h.keys.dana, {
      state: started.body.state,
      error: 'access_denied',
    });
    expect(declined.body).toEqual({ cancelled: true });
    const hook = await claim(h, f.job.id);
    expect(hook).not.toBeNull();
    const refused = await authorize(h, h.keys.dana, {
      connectionId: f.cid,
      expectedGeneration: generation,
    });
    expect(refused.body.error.code).toBe('cleanup_running');
    const [job] = await partialJobs(f.cid);
    expect(job?.expires_at).toEqual(f.job.expires_at);
  });

  it('a completed reconnect supersedes it in the same transaction', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const generation = (await connectionRow(f.cid))?.generation;
    const started = await authorize(h, h.keys.dana, {
      connectionId: f.cid,
      expectedGeneration: generation,
    });
    const done = await complete(h, h.keys.dana, { state: started.body.state, code: 'again' });
    expect(done.body).toEqual({ id: f.cid, state: 'connecting' });
    const [job] = await partialJobs(f.cid);
    expect([job?.status, job?.code]).toEqual(['cancelled', 'superseded']);
  });

  it('a disconnect cancels it and queues the full hook', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    await t.request(`${h.base}/connections/${f.cid}`, { key: h.keys.dana, method: 'DELETE' });
    const [job] = await partialJobs(f.cid);
    expect(job?.status).toBe('cancelled');
    const full =
      await db.owner`select input from extension_jobs where connection_id=${f.cid} and trigger_kind='disconnect' and status='queued'`;
    expect(full.map((j) => j.input)).toEqual([{}]);
  });

  it('holds a release change while blocking and fails, not cancels, it after the deadline', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const upgrade = async () => {
      const input = {
        installationId: h.id,
        registrationId: nextManifest.universalId,
        version: nextManifest.version,
        settings: { share: true },
      };
      const preview = await t.request('/v1/extensions/preview', { key: h.keys.admin, body: input });
      return t.request(`${h.base}/upgrade`, {
        key: h.keys.admin,
        headers: { 'Idempotency-Key': randomUUID() },
        body: { ...input, planDigest: preview.body.planDigest },
      });
    };
    const held = await upgrade();
    expect(held.body.error?.code).toBe('cleanup_pending');
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${f.job.id}`;
    const accepted = await upgrade();
    expect(accepted.status).toBeLessThan(300);
    const [job] = await partialJobs(f.cid);
    expect([job?.status, job?.code]).toEqual(['failed', 'cleanup_deadline_expired']);
    expect((await connectionRow(f.cid))?.release_incidents).toEqual([`cleanup:${f.job.id}`]);
  });

  it('a manual retry keeps its deadline', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const hook = await claim(h, f.job.id);
    if (!hook) throw new Error('hook missing');
    await h.queue.complete(hook.run, { status: 'failed', code: 'release_incomplete' });
    const retried = await t.request(`${h.base}/runs/${f.job.id}/retry`, {
      key: h.keys.admin,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(retried.status).toBe(200);
    const [job] = await partialJobs(f.cid);
    expect(job?.status).toBe('queued');
    expect(job?.expires_at).toEqual(f.job.expires_at);
  });

  it('uninstalling cancels it and does not wait for its deadline', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    expect((await t.request(`${h.base}/uninstall`, { key: h.keys.admin, body: {} })).status).toBe(
      200,
    );
    const [job] = await partialJobs(f.cid);
    expect(job?.status).toBe('cancelled');
  });
});

describe('the blocking rule', () => {
  it('matches between SQL and TypeScript on every case', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000),
      future = new Date(now.getTime() + 60_000);
    const cases = [];
    for (const status of ['queued', 'running', 'failed'])
      for (const expires of [past, future])
        for (const lease of [null, past, future])
          for (const input of [{ keep: 'current' }, {}])
            cases.push({ status, expires_at: expires, lease_until: lease, input });
    for (const c of cases) {
      const [sql] = await db.owner<
        { blocking: boolean }[]
      >`select retainer_partial_release_job('disconnect',${db.owner.json(c.input)}::jsonb)
          and ${c.status} in ('queued','running')
          and (clock_timestamp()<${c.expires_at}::timestamptz or (${c.status}='running' and clock_timestamp()<${c.lease_until}::timestamptz)) is true as blocking`;
      const ts = isPartialReleaseBlocking(
        { trigger_kind: 'disconnect', ...c, lease_until: c.lease_until },
        new Date(),
      );
      expect(sql?.blocking ?? false).toBe(ts);
    }
  });

  it('the SQL function agrees with cleanupPending on a stored job', async () => {
    const h = await setup();
    const f = await failedConnect(h, h.keys.dana);
    const blocking = async () =>
      (
        await db.owner`select retainer_partial_release_blocking(j) as b from extension_jobs j where id=${f.job.id}`
      )[0]?.b;
    expect(await blocking()).toBe(true);
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${f.job.id}`;
    expect(await blocking()).toBe(false);
    await db.owner`update extension_jobs set status='running',lease_until=clock_timestamp()+interval '1 minute' where id=${f.job.id}`;
    expect(await blocking()).toBe(true);
    expect(isPartialReleaseJob({ trigger_kind: 'disconnect', input: { keep: 'current' } })).toBe(
      true,
    );
    expect(isPartialReleaseJob({ trigger_kind: 'disconnect', input: {} })).toBe(false);
  });

  it('no query reads disconnect jobs without the partial-release predicate', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const offenders: string[] = [];
    for (const dir of ['extension-runtime', 'extensions']) {
      for (const file of readdirSync(join(root, dir))) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        const text = readFileSync(join(root, dir, file), 'utf8');
        // Each tagged SQL template, as written in source.
        for (const match of text.matchAll(/tx(?:<[^`]*?>)?`([^`]*)`/gs)) {
          const query = match[1] ?? '';
          // cancelRuns's `trigger_kind<>'disconnect'` excludes both kinds alike, by design.
          if (
            /trigger_kind\s*(=|in\s*\()[^;]*'disconnect'/i.test(query) &&
            !/retainer_partial_release_(job|blocking)/.test(query)
          )
            offenders.push(`${dir}/${file}: ${query.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('release incidents and the notice', () => {
  async function withIncident(h: Setup, key: string) {
    const c = await connected(h, key);
    await h.queue.complete(c.run, {
      status: 'succeeded',
      releaseIncomplete: [`exchange:${'a'.repeat(64)}`],
    });
    return c;
  }

  it('records each incident once and stamps a later time for a new one', async () => {
    const h = await setup();
    const c = await withIncident(h, h.keys.dana);
    const first = await connectionRow(c.cid);
    expect(first?.release_incidents).toEqual([`exchange:${'a'.repeat(64)}`]);
    const [conn] = await db.owner`select generation from extension_connections where id=${c.cid}`;
    const [inst] =
      await db.owner`select generation,release_digest,workspace_id from extension_installations where id=${h.id}`;
    const record = async (ids: string[]) => {
      const jobId = randomUUID();
      await db.owner`insert into extension_jobs(id,workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,
        function_id,input,input_hash,dedupe_key,cause,trigger_kind)
        values(${jobId},${inst?.workspace_id},${h.id},${c.cid},${conn?.generation},${inst?.generation},${inst?.release_digest},
        ${workId},'{}','x',${randomUUID()},'[]','job')`;
      const work = await claim(h, jobId);
      if (!work) throw new Error('work missing');
      await h.queue.complete(work.run, { status: 'succeeded', releaseIncomplete: ids });
    };
    await record([`exchange:${'a'.repeat(64)}`]);
    expect((await connectionRow(c.cid))?.release_incomplete_at).toBe(first?.release_incomplete_at);
    await record([`release:${randomUUID()}`]);
    const later = await connectionRow(c.cid);
    expect(later?.release_incidents).toHaveLength(2);
    expect(later?.release_incomplete_at).not.toBe(first?.release_incomplete_at);
  });

  it('shows only the caller their own notice, dismisses exactly what they saw, and refuses malformed stamps', async () => {
    const h = await setup();
    const c = await withIncident(h, h.keys.dana);
    expect((await t.request(h.base, { key: h.keys.eli })).body.releaseNotice).toBeNull();
    const notice = (await t.request(h.base, { key: h.keys.dana })).body.releaseNotice;
    expect(notice.connectionId).toBe(c.cid);
    // Microsecond precision survives the round trip; a millisecond copy does not match.
    const [stamp] =
      await db.owner`select release_incomplete_at from extension_connections where id=${c.cid}`;
    const truncated = (stamp?.release_incomplete_at as Date).toISOString();
    const dismiss = (key: string, at: unknown) =>
      t.request(`${h.base}/connections/${c.cid}/release-notice/dismiss`, { key, body: { at } });
    await db.owner`update extension_connections set release_incomplete_at=release_incomplete_at+interval '123 microseconds' where id=${c.cid}`;
    const precise = (await t.request(h.base, { key: h.keys.dana })).body.releaseNotice.at;
    for (const at of ['invalid', 'x'.repeat(100), '2026-11-15T10:00:00', truncated])
      expect((await dismiss(h.keys.dana, at)).body.error.code).toBe('notice_changed');
    expect((await dismiss(h.keys.dana, '2999-01-01T00:00:00Z')).body.error.code).toBe(
      'notice_changed',
    );
    expect((await dismiss(h.keys.eli, precise)).status).toBe(404);
    expect((await dismiss(h.keys.dana, precise)).body).toEqual({ dismissed: true });
    expect((await t.request(h.base, { key: h.keys.dana })).body.releaseNotice).toBeNull();
    // The same incident again stays hidden; a new one shows.
    await h.queue
      .complete(c.run, { status: 'succeeded', releaseIncomplete: [`exchange:${'a'.repeat(64)}`] })
      .catch(() => undefined);
    expect((await t.request(h.base, { key: h.keys.dana })).body.releaseNotice).toBeNull();
  });

  it('a new incident between reading and dismissing stays visible', async () => {
    const h = await setup();
    const c = await withIncident(h, h.keys.dana);
    const seen = (await t.request(h.base, { key: h.keys.dana })).body.releaseNotice.at;
    await inWorkspace(t.sql, h.workspace, async (tx) => {
      const { recordReleaseIncidents } = await import('../../src/extension-runtime/lifecycle.js');
      await recordReleaseIncidents(tx, c.cid, [`release:${randomUUID()}`]);
    });
    const answer = await t.request(`${h.base}/connections/${c.cid}/release-notice/dismiss`, {
      key: h.keys.dana,
      body: { at: seen },
    });
    expect(answer.body.error.code).toBe('notice_changed');
    expect((await t.request(h.base, { key: h.keys.dana })).body.releaseNotice).not.toBeNull();
  });

  it('a dismissal racing a new incident never hides the new one', async () => {
    const h = await setup();
    const c = await withIncident(h, h.keys.dana);
    const { recordReleaseIncidents } = await import('../../src/extension-runtime/lifecycle.js');
    for (let round = 0; round < 3; round++) {
      const seen = (await t.request(h.base, { key: h.keys.dana })).body.releaseNotice?.at;
      if (!seen) throw new Error('notice missing');
      await Promise.all([
        t.request(`${h.base}/connections/${c.cid}/release-notice/dismiss`, {
          key: h.keys.dana,
          body: { at: seen },
        }),
        inWorkspace(t.sql, h.workspace, (tx) =>
          recordReleaseIncidents(tx, c.cid, [`release:${randomUUID()}`]),
        ),
      ]);
      expect((await t.request(h.base, { key: h.keys.dana })).body.releaseNotice).not.toBeNull();
    }
  });
});

describe('operator OAuth client configuration', () => {
  const parse = (value: unknown) =>
    parseOAuthClients(JSON.stringify(value), catalog, 'https://retainer.test');
  it('accepts https, and http only for localhost', () => {
    expect(parse({ [manifest.universalId]: client }).get(manifest.universalId)?.keyFallback).toBe(
      true,
    );
    expect(
      parse({
        [manifest.universalId]: { ...client, tokenEndpoint: 'http://127.0.0.1:9999/token' },
      }).size,
    ).toBe(1);
    expect(() =>
      parse({ [manifest.universalId]: { ...client, tokenEndpoint: 'http://provider.test/token' } }),
    ).toThrow();
  });
  it('refuses a registration without an OAuth release, and malformed values', () => {
    expect(() => parse({ [keyOnly.universalId]: client })).toThrow('without an OAuth release');
    expect(() => parse({ [manifest.universalId]: { clientId: 'x' } })).toThrow();
    expect(() => parseOAuthClients('not json', catalog, 'https://retainer.test')).toThrow();
  });
  it('is unavailable without a public origin', () => {
    expect(
      parseOAuthClients(JSON.stringify({ [manifest.universalId]: client }), catalog, undefined)
        .size,
    ).toBe(0);
  });
});
