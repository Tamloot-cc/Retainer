import { randomBytes, randomUUID } from 'node:crypto';
import { type Invocation, isRetryLater, retryLaterResult } from '@retainer/extension';
import { executeTamloot } from '@retainer/runner/tamloot';
import { TAMLOOT, tamlootManifest } from '@retainer/runner/tamloot-contract';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let tokens: RunTokens, broker: SecretBroker;
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
});
async function fixture() {
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
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Tamloot ${randomUUID()}` },
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
  const install = await queue.claim(workspace.id, installJob!.id, 'install');
  expect(install).not.toBeNull();
  await queue.complete(install!, { status: 'succeeded' });
  const sessionId = randomUUID(),
    accountId = randomUUID(),
    task1 = randomUUID(),
    task2 = randomUUID();
  let version = 1,
    status = 200,
    expire = false,
    taskRows = [
      {
        id: task1,
        content: 'First action',
        status: 'open',
        contact_emails: ['participant@tamloot.test'],
      },
      { id: task2, content: 'Second action', status: 'done', contact_emails: [] },
    ];
  let cursor = 1;
  let checkpointFailures = 0,
    checkpointCommitsBeforeFailure = false;
  const requests: string[] = [],
    bodies: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.origin === 'https://retainer.test') {
      if (target.pathname.endsWith('/runtime/checkpoint') && checkpointFailures > 0) {
        checkpointFailures--;
        if (checkpointCommitsBeforeFailure) await app.inProcessFetch(url, init);
        return Response.json(
          { error: { code: 'unavailable', message: 'fixture checkpoint outage' } },
          { status: 503 },
        );
      }
      if (init?.body) bodies.push(String(init.body));
      return app.inProcessFetch(url, init);
    }
    expect(target.origin).toBe('https://api.tamloot.cc');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-tamloot-key');
    expect(init?.redirect).toBe('error');
    requests.push(target.pathname);
    if (status === 401 || status === 429)
      return Response.json(
        { private: 'NEVER STORE THIS' },
        { status, headers: { 'retry-after': '90' } },
      );
    if (target.pathname === '/v1/me')
      return Response.json({ data: { user_id: accountId, email: 'owner@tamloot.test' } });
    if (target.pathname === '/v1/changes/head')
      return Response.json({ data: { cursor: `head-${cursor}` } });
    if (target.pathname === '/v1/sessions') {
      expect(target.searchParams.get('limit')).toBe('25');
      return Response.json({
        data: [{ id: sessionId, recording_status: 'completed' }],
        pagination: { has_more: false, next_offset: null },
      });
    }
    if (target.pathname === '/v1/changes') {
      if (expire) {
        expire = false;
        return Response.json({ code: 'cursor_expired' }, { status: 410 });
      }
      cursor++;
      return Response.json({
        data: [
          {
            entity: 'task',
            entity_id: task1,
            session_id: sessionId,
            op: 'delete',
            revision: version,
          },
        ],
        has_more: false,
        next_cursor: `head-${cursor}`,
      });
    }
    if (target.pathname === `/v1/sessions/${sessionId}`) {
      if (status !== 200) return Response.json({ private: 'NEVER STORE THIS' }, { status });
      return Response.json({
        data: {
          id: sessionId,
          revision: version,
          session_date: '2026-11-01T12:00:00Z',
          title: `Meeting ${version}`,
          recording_status: 'completed',
          participants: [{ name: 'Participant', emails: ['participant@tamloot.test'] }],
          notes: [{ title: 'Notes', content: 'a'.repeat(22000) }],
          transcript: 'NEVER IMPORT TRANSCRIPT',
          google_doc_link: 'NEVER IMPORT LINK',
        },
      });
    }
    expect(target.pathname).toBe('/v1/tasks');
    expect(target.searchParams.get('session_id')).toBe(sessionId);
    return Response.json({ data: taskRows });
  };
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
    return result;
  }
  async function drain() {
    const results = [];
    for (let n = 0; n < 25; n++) {
      const [next] =
        await db.owner`select id from extension_jobs where installation_id=${id} and status='queued' and available_at<=clock_timestamp() order by created_at,id limit 1`;
      if (!next) return results;
      const run = await queue.claim(workspace.id, next.id, 'tamloot-fixture');
      if (!run) throw new Error('missing fixture claim');
      results.push(await execute(run));
      if (results.at(-1)?.status === 'retry') return results;
    }
    throw new Error('fixture queue did not drain');
  }
  async function connect() {
    const stage = await app.request(`${base}/connections/secrets`, {
      key: keys.member,
      body: { name: 'apiKey', value: 'fixture-tamloot-key' },
    });
    expect(stage.status).toBe(201);
    const connected = await app.request(`${base}/connections`, {
      key: keys.member,
      body: { settings: { backfillDays: 31 }, secretRefs: { apiKey: stage.body.pendingSecretId } },
    });
    expect(connected.status).toBe(201);
    return connected.body.id as string;
  }
  async function poll() {
    await queue.scheduleTick(workspace.id, id);
    await db.owner`update extension_schedules set next_due_at=clock_timestamp()-interval '5 minutes' where installation_id=${id} and connection_id is not null`;
    await queue.scheduleTick(workspace.id, id);
    return drain();
  }
  return {
    app,
    keys,
    workspace: workspace.id,
    id,
    base,
    connect,
    poll,
    drain,
    requests,
    bodies,
    task1,
    task2,
    failNextCheckpoint: (afterCommit = false) => {
      checkpointFailures++;
      checkpointCommitsBeforeFailure = afterCommit;
    },
    retryNow: async () => {
      await db.owner`update extension_jobs set available_at=clock_timestamp() where installation_id=${id} and status='queued'`;
    },
    setVersion: (v: number) => {
      version = v;
    },
    setStatus: (v: number) => {
      status = v;
    },
    expire: () => {
      expire = true;
    },
    setTasks: (v: typeof taskRows) => {
      taskRows = v;
    },
  };
}
describe('Tamloot bundle through real API and Postgres with provider HTTP fixtures', () => {
  it('backfills, matches people, retains full notes and reconciles task-only changes and provider deletion', async () => {
    const h = await fixture(),
      cid = await h.connect();
    const results = await h.drain();
    expect(results.every((r) => r.status === 'succeeded')).toBe(true);
    expect(h.requests.indexOf('/v1/changes/head')).toBeLessThan(h.requests.indexOf('/v1/sessions'));
    const tasks =
      await db.owner`select t.*,r.created_by from source_tasks t join records r on r.id=t.record_id where t.installation_id=${h.id} order by external_id`;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.created_by).toMatchObject({
      type: 'integration',
      id: h.id,
      name: "Tamloot (Dana's account)",
    });
    expect(
      await db.owner`select 1 from record_identifiers where workspace_id=${h.workspace} and kind='email' and value='participant@tamloot.test' and is_claim`,
    ).toHaveLength(1);
    const before =
      await db.owner`select id from source_revisions where item_id in(select id from source_items where account_id in(select account_id from source_bindings where installation_id=${h.id}))`;
    h.setTasks([
      {
        id: h.task1,
        content: 'Task changed without session revision',
        status: 'done',
        contact_emails: [],
      },
    ]);
    expect((await h.poll()).every((r) => r.status === 'succeeded')).toBe(true);
    expect(
      await db.owner`select id from source_revisions where item_id in(select id from source_items where account_id in(select account_id from source_bindings where installation_id=${h.id}))`,
    ).toHaveLength(before.length);
    const [kept] =
      await db.owner`select r.data,t.state from source_tasks t join records r on r.id=t.record_id where t.installation_id=${h.id} and t.external_id=${h.task1}`;
    expect(JSON.stringify(kept!.data)).toContain('Task changed without session revision');
    const [removed] =
      await db.owner`select state from source_tasks where installation_id=${h.id} and external_id=${h.task2}`;
    expect(removed!.state).toBe('removed');
    h.setStatus(410);
    expect((await h.poll()).every((r) => r.status === 'succeeded')).toBe(true);
    expect(
      await db.owner`select r.id from source_tasks t join records r on r.id=t.record_id where t.installation_id=${h.id} and r.deleted_at is null`,
    ).toHaveLength(0);
    expect(
      (await h.app.request(`${h.base}/connections`, { key: h.keys.member })).body.connections.find(
        (c: { id: string }) => c.id === cid,
      ).health,
    ).toBe('ok');
    expect(h.bodies.join(' ')).not.toContain('NEVER IMPORT');
    expect(h.bodies.join(' ')).toContain('a'.repeat(22000));
  }, 60000);
  it('preserves edited tasks across a new meeting revision, recovers an expired cursor and suppresses erased sources', async () => {
    const h = await fixture();
    await h.connect();
    await h.drain();
    const [task] =
      await db.owner`select record_id from source_tasks where installation_id=${h.id} and external_id=${h.task1}`;
    expect(
      (
        await h.app.request(`/v1/records/${task!.record_id}`, {
          key: h.keys.member,
          method: 'PATCH',
          body: { values: { title: 'My action' } },
        })
      ).status,
    ).toBe(200);
    h.setVersion(2);
    h.setTasks([]);
    h.expire();
    expect((await h.poll()).every((r) => r.status === 'succeeded')).toBe(true);
    const read = await h.app.request(`/v1/records/${task!.record_id}`, { key: h.keys.admin });
    expect(read.body.fields.title).toBe('My action');
    const [item] =
      await db.owner`select v.event_id from source_revisions v join source_items s on s.id=v.item_id join source_bindings b on b.account_id=s.account_id where b.installation_id=${h.id} and v.is_current`;
    expect(
      (await h.app.request(`/v1/records/${item!.event_id}/forget`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    const count = (
      await db.owner`select count(*)::int n from source_revisions v join source_items s on s.id=v.item_id join source_accounts a on a.id=s.account_id where a.workspace_id=${h.workspace}`
    )[0]!.n;
    expect((await h.poll()).every((r) => r.status === 'succeeded')).toBe(true);
    expect(
      (
        await db.owner`select count(*)::int n from source_revisions v join source_items s on s.id=v.item_id join source_accounts a on a.id=s.account_id where a.workspace_id=${h.workspace}`
      )[0]!.n,
    ).toBe(count);
  }, 60000);
  it('backs off on 429 and marks revoked member credentials as needing reconnect', async () => {
    const h = await fixture(),
      cid = await h.connect();
    h.setStatus(429);
    expect(await h.drain()).toContainEqual({
      status: 'retry',
      code: 'provider_rate_limited',
      retryAfterSeconds: 90,
    });
    await db.owner`update extension_jobs set available_at=clock_timestamp() where connection_id=${cid} and status='queued'`;
    h.setStatus(401);
    expect(await h.drain()).toContainEqual({ status: 'failed', code: 'provider_unauthorized' });
    const [connection] = await db.owner`select health from extension_connections where id=${cid}`;
    expect(connection!.health).toBe('needs_reconnect');
  }, 60000);
});

describe('Tamloot connect checkpoint recovery', () => {
  it.each(['before', 'after'] as const)(
    'recovers a checkpoint failure %s commit without losing backfill',
    async (when) => {
      const h = await fixture(),
        cid = await h.connect();
      h.failNextCheckpoint(when === 'after');
      expect(await h.drain()).toContainEqual({ status: 'retry', code: 'api_unavailable' });
      expect(
        await db.owner`select scan_id from source_sync_state where connection_id=${cid}`,
      ).toHaveLength(0);
      expect(
        await db.owner`select key from extension_kv where connection_id=${cid} and key='tamloot-feed'`,
      ).toHaveLength(when === 'after' ? 1 : 0);
      await h.retryNow();
      const results = await h.drain();
      expect(results.every((result) => result.status === 'succeeded')).toBe(true);
      const [connection] = await db.owner`select state from extension_connections where id=${cid}`;
      expect(connection?.state).toBe('active');
      expect(
        await db.owner`select id from source_tasks where installation_id=${h.id}`,
      ).toHaveLength(2);
    },
    60000,
  );
});
