import { randomBytes, randomUUID } from 'node:crypto';
import { type Invocation, isRetryLater, retryLaterResult } from '@retainer/extension';
import { executeTamloot } from '@retainer/runner/tamloot';
import { tamlootManifest } from '@retainer/runner/tamloot-contract';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TamlootFixture, testClock } from '../../../runner/src/tamloot-test-fixture.js';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { runCli } from '../../src/operator/commands.js';
import { parseOAuthClients } from '../../src/extensions/oauth-clients.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

// The whole round trip: the real API and Postgres, the real Tamloot bundle, and
// a local stand-in for Tamloot's token endpoint and API (the runner's fixture).
const db = useTestDatabase();
const REDIRECT = 'https://retainer.test/app/connect/callback';
let tokens: RunTokens, broker: SecretBroker, fx: TamlootFixture;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'tamloot',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
  fx = await new TamlootFixture({
    clock: testClock(Date.now()),
    clientId: 'retainer-client',
    clientSecret: 'retainer-secret',
    redirectUri: REDIRECT,
  }).start();
});
afterAll(() => fx?.stop());

async function setup() {
  const manifest = tamlootManifest({
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    }),
    catalog = new ExtensionCatalog([
      { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ]);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    extensionSecrets: broker,
    extensionOAuthClients: parseOAuthClients(
      JSON.stringify({
        [manifest.universalId]: {
          clientId: 'retainer-client',
          clientSecret: 'retainer-secret',
          authorizationEndpoint: `${fx.origin}/oauth/start`,
          tokenEndpoint: `${fx.origin}/auth/v1/oauth/token`,
          apiOrigin: fx.origin,
        },
      }),
      catalog,
      'https://retainer.test',
    ),
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Tamloot OAuth ${randomUUID()}` },
    {
      admin: {
        actor: { type: 'user', id: 'admin', name: 'Admin' },
        scopes: ['admin', 'read', 'write'],
      },
      member: { actor: { type: 'user', id: 'member', name: 'Dana' }, scopes: ['read', 'write'] },
    },
  );
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings: { shareMeetings: true, createPeople: 'everyone' },
  };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { ...input, planDigest: preview.body.planDigest },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    base = `/v1/extensions/${id}`,
    queue = new ExtensionQueue(app.sql, catalog.runtime);
  const [installJob] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const install = await queue.claim(workspace.id, installJob?.id, 'install');
  if (!install) throw new Error('install missing');
  await queue.complete(install, { status: 'succeeded' });

  const transport: typeof fetch = (url, init) =>
    new URL(String(url)).origin === 'https://retainer.test'
      ? app.inProcessFetch(url, init)
      : fx.transport(url, init);
  async function execute(job: ClaimedJob) {
    const token = await tokens.issue(app.sql, job, manifest.universalId, job.scopes);
    const result = await executeTamloot(
      {
        protocolVersion: 1,
        runId: job.jobId,
        attempt: job.attempt,
        installationId: id,
        releaseDigest: job.releaseDigest,
        functionId: job.functionId,
        input: job.input as Invocation['input'],
        apiOrigin: 'https://retainer.test',
        runToken: token,
        deadline: job.deadline.toISOString(),
      },
      new AbortController().signal,
      transport,
    ).catch((error) => {
      if (isRetryLater(error)) return retryLaterResult(error);
      throw error;
    });
    await queue.complete(job, result);
    return { trigger: job.triggerKind, input: job.input, result };
  }
  async function drain() {
    const results = [];
    for (let n = 0; n < 40; n++) {
      const [next] =
        await db.owner`select id from extension_jobs where installation_id=${id} and status='queued' and available_at<=clock_timestamp() order by created_at,id limit 1`;
      if (!next) return results;
      const run = await queue.claim(workspace.id, next.id, 'tamloot-oauth');
      if (!run) return results;
      results.push(await execute(run));
    }
    throw new Error('queue did not drain');
  }
  /** The member clicks Connect, approves as `account` in Tamloot and lands back. */
  async function connect(account: string, reconnect?: { connectionId: string }) {
    let expectedGeneration: number | undefined;
    if (reconnect) {
      const [row] =
        await db.owner`select generation from extension_connections where id=${reconnect.connectionId}`;
      expectedGeneration = row?.generation;
    }
    const started = await app.request(`${base}/connections/authorize`, {
      key: keys.member,
      body: {
        settings: { backfillDays: 31 },
        ...(reconnect ? { connectionId: reconnect.connectionId, expectedGeneration } : {}),
      },
    });
    expect(started.status).toBe(201);
    const url = new URL(started.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    const code = fx.approve(account, url.searchParams.get('code_challenge') ?? '');
    const done = await app.request(`${base}/connections/authorize/complete`, {
      key: keys.member,
      body: { state: started.body.state, code },
    });
    expect(done.status).toBe(200);
    return done.body.id as string;
  }
  const connection = async (cid: string) =>
    (
      await db.owner`select state,last_error,credential,release_incidents from extension_connections where id=${cid}`
    )[0];
  return {
    app,
    keys,
    base,
    id,
    connect,
    drain,
    connection,
    registrationId: manifest.universalId,
  };
}

describe('Connect with Tamloot through the real API, Postgres and bundle', () => {
  it('connects, imports with the session, and gives it up on disconnect', async () => {
    const h = await setup();
    const cid = await h.connect('dana');
    const runs = await h.drain();
    expect(runs[0]?.trigger).toBe('connect');
    expect(runs[0]?.result.status).toBe('succeeded');
    expect(await h.connection(cid)).toMatchObject({ state: 'active', credential: 'oauth' });
    expect(fx.liveSessions('dana')).toHaveLength(1);
    expect(fx.listsRetainer('dana')).toBe(true);
    expect(fx.calls('token').map((c) => c.grant)).toContain('authorization_code');

    const disconnected = await h.app.request(`${h.base}/connections/${cid}`, {
      key: h.keys.member,
      method: 'DELETE',
    });
    expect(disconnected.status).toBe(200);
    const cleanup = await h.drain();
    expect(cleanup.map((r) => [r.trigger, r.result.status])).toEqual([
      ['disconnect', 'succeeded'],
    ]);
    expect(fx.liveSessions('dana')).toHaveLength(0);
    expect(fx.listsRetainer('dana')).toBe(false);
    const [secret] =
      await db.owner`select delete_after<=clock_timestamp() as retired from extension_secrets where connection_id=${cid} and name='oauthTokens'`;
    expect(secret?.retired).toBe(true);
    expect((await h.connection(cid))?.release_incidents).toEqual([]);
  });

  it('a reconnect with another account keeps the first session and releases the rejected one', async () => {
    const h = await setup();
    const cid = await h.connect('erin');
    await h.drain();
    expect(fx.liveSessions('erin')).toHaveLength(1);
    await h.connect('frank', { connectionId: cid });
    const runs = await h.drain();
    expect(runs.map((r) => [r.trigger, r.input, r.result.status])).toEqual([
      ['connect', expect.anything(), 'failed'],
      ['disconnect', { keep: 'current' }, 'succeeded'],
    ]);
    expect(await h.connection(cid)).toMatchObject({
      state: 'setup_failed',
      last_error: 'source_account_changed',
    });
    expect(fx.liveSessions('frank')).toHaveLength(0);
    expect(fx.liveSessions('erin')).toHaveLength(1);
  });

  it('the operator command counts connections by method, time to connect and leaks', async () => {
    const h = await setup();
    const measure = async () => {
      const out: string[] = [];
      expect(
        await runCli(['extension', 'connections', '--days', '7', '--json'], {
          sql: db.owner,
          out: (line) => out.push(line),
          err: () => {},
        }),
      ).toBe(0);
      const rows = JSON.parse(out.join('\n')) as {
        registrationId: string;
        newConnections: { oauth: number; key: number };
        connectSeconds: { count: number; median: number | null };
        releaseIncomplete: number;
      }[];
      return rows.find((r) => r.registrationId === h.registrationId);
    };
    const before = await measure();
    const cid = await h.connect('gina');
    await h.drain();
    await db.owner`update extension_connections set authorization_started_at=connected_at-interval '42 seconds' where id=${cid}`;
    await db.owner`update extension_connections set release_incomplete_at=clock_timestamp() where id=${cid}`;
    const after = await measure();
    expect(after?.newConnections.oauth).toBe((before?.newConnections.oauth ?? 0) + 1);
    expect(after?.newConnections.key).toBe(before?.newConnections.key ?? 0);
    expect(after?.connectSeconds.count).toBe((before?.connectSeconds.count ?? 0) + 1);
    expect(after?.releaseIncomplete).toBe((before?.releaseIncomplete ?? 0) + 1);
    const human: string[] = [];
    await runCli(['extension', 'connections'], {
      sql: db.owner,
      out: (line) => human.push(line),
      err: () => {},
    });
    expect(human.join('\n')).toContain('access may remain');
  });
});
