import { createHash, randomUUID } from 'node:crypto';
import type { Invocation } from '@retainer/extension';
import { executeGmail } from '@retainer/runner/gmail';
import { GMAIL, gmailManifest } from '@retainer/runner/gmail-contract';
import { generateKeyPair } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanGmailAuthorizations } from '../../src/extension-runtime/gmail-cleanup.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const origin = 'https://retainer.test';
const memberId = `member | ${'a'.repeat(256)}`;
const gmailReadonly = 'https://www.googleapis.com/auth/gmail.readonly';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('connects with consent, imports qualifying Gmail text, backfills new People, and releases Nango on disconnect', async () => {
  const manifest = gmailManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]);
  const [release] = catalog.list();
  if (!release) throw new Error('missing Gmail release');
  const pair = await generateKeyPair('EdDSA');
  const tokens = new RunTokens({
    issuer: origin,
    keyId: 'test',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
  const t = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    runTokens: tokens,
  });
  const { workspace, keys } = await t.setupWorkspace(
    { name: 'Gmail' },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      member: { actor: { type: 'user', id: memberId }, scopes: ['read', 'write'] },
      other: { actor: { type: 'user', id: 'other' }, scopes: ['read', 'write'] },
    },
  );
  const install = {
    registrationId: GMAIL.registration,
    version: manifest.version,
    settings: { historyDays: 2, nangoIntegrationId: 'google-mail' },
  };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: install });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const installation = await t.request('/v1/extensions', {
    key: keys.admin,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { ...install, planDigest: preview.body.planDigest },
  });
  expect(installation.status, JSON.stringify(installation.body)).toBe(201);
  const id = installation.body.id as string;
  const base = `/v1/extensions/${id}`;
  const queue = new ExtensionQueue(t.sql, catalog.runtime);
  const jobId = async (trigger: string) => {
    const [job] = await db.owner<
      { id: string }[]
    >`select id from extension_jobs where installation_id=${id}
      and trigger_kind=${trigger} and status='queued' order by created_at,id limit 1`;
    return job?.id;
  };
  const claim = async (trigger: string) => {
    const job = await jobId(trigger);
    if (!job) throw new Error(`no queued ${trigger} job`);
    const run = await queue.claim(workspace.id, job, 'gmail-test');
    if (!run) throw new Error(`could not claim ${trigger} job`);
    return run;
  };
  const runWorker = async (
    trigger: string,
    expected: { status: string; code?: string } = { status: 'succeeded' },
  ) => {
    const run = await claim(trigger);
    const runToken = await tokens.issue(t.sql, run, GMAIL.registration, run.scopes);
    const invoke = () =>
      executeGmail(
        {
          protocolVersion: 1,
          runId: run.jobId,
          attempt: run.attempt,
          installationId: id,
          releaseDigest: run.releaseDigest,
          functionId: run.functionId,
          input: run.input as Invocation['input'],
          apiOrigin: origin,
          runToken,
          deadline: run.deadline.toISOString(),
        },
        AbortSignal.timeout(10000),
        (async (url: URL, init?: RequestInit) => {
          const response = await t.inProcessFetch(url, init);
          if (!response.ok && !String(url).endsWith('/runtime/gmail/proxy'))
            throw new Error(`${url.pathname}: ${response.status} ${await response.text()}`);
          return response;
        }) as typeof fetch,
      );
    const result = await invoke();
    expect(result).toEqual(expected);
    await queue.complete(run, result);
  };
  if (await jobId('install')) await queue.complete(await claim('install'), { status: 'succeeded' });
  const addPerson = async (email: string) => {
    const response = await t.request('/v1/objects/person/records', {
      key: keys.member,
      body: { values: { name: email, emails: email } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  };
  await addPerson('existing@example.test');
  let tags: Record<string, string> = {};
  let scope = `${gmailReadonly} https://mail.google.com/`;
  let staleHistory = false;
  let revoked = false;
  let profileReads = 0;
  const deleted: string[] = [];
  let nangoConnectionId = 'rejected-test';
  let failedDeletes = 2;
  const grants = new Map<string, { tags: Record<string, string>; scope: string }>();
  const readingGrant = gate();
  const finishReadingGrant = gate();
  const fullReads: string[] = [];
  const messageDate = Date.now() - 3_600_000;
  const from = {
    eligible: 'existing@example.test',
    ccOnly: 'unknown@example.test',
    targeted: 'new@example.test',
  } as const;
  vi.stubEnv('RETAINER_GMAIL_NANGO_CONTROL_KEY', 'control-test');
  vi.stubEnv('RETAINER_GMAIL_NANGO_PROXY_KEY', 'proxy-test');
  vi.stubEnv('RETAINER_GMAIL_NANGO_CLEANUP_KEY', 'cleanup-test');
  vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://api.nango.dev');
    const headers = new Headers(init.headers);
    const { pathname, searchParams } = url;
    if (pathname === '/connect/sessions') {
      expect(headers.get('authorization')).toBe('Bearer control-test');
      const request = JSON.parse(String(init.body));
      expect(request.allowed_integrations).toEqual(['google-mail']);
      expect(
        request.integrations_config_defaults['google-mail'].connection_config.oauth_scopes_override,
      ).toBe(gmailReadonly);
      tags = request.tags;
      grants.set(nangoConnectionId, { tags, scope });
      return Response.json({
        data: {
          connect_link: 'https://connect.nango.dev/test',
          expires_at: new Date(Date.now() + 600000).toISOString(),
        },
      });
    }
    const nangoRow = (id: string, grant: { tags: Record<string, string> }) => ({
      connection_id: id,
      provider: 'google-mail',
      provider_config_key: 'google-mail',
      tags: grant.tags,
    });
    if (pathname === '/connections') {
      expect(['Bearer control-test', 'Bearer cleanup-test']).toContain(
        headers.get('authorization'),
      );
      const matches = [...grants].filter(([, grant]) =>
        Object.entries(grant.tags).every(
          ([key, value]) => searchParams.get(`tags[${key}]`) === value,
        ),
      );
      return Response.json({
        connections: matches.slice(0, 3).map(([id, grant]) => nangoRow(id, grant)),
      });
    }
    if (pathname.startsWith('/connections/')) {
      const connectionId = pathname.slice('/connections/'.length);
      expect(searchParams.get('provider_config_key')).toBe('google-mail');
      const grant = grants.get(connectionId);
      if (!grant) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (init.method === 'DELETE') {
        expect(['Bearer control-test', 'Bearer cleanup-test']).toContain(
          headers.get('authorization'),
        );
        if (failedDeletes > 0) {
          failedDeletes--;
          return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
        }
        deleted.push(connectionId);
        grants.delete(connectionId);
        return Response.json({ success: true });
      }
      expect(headers.get('authorization')).toBe('Bearer control-test');
      if (connectionId === 'racing-test') {
        readingGrant.resolve();
        await finishReadingGrant.promise;
      }
      return Response.json({
        ...nangoRow(connectionId, grant),
        credentials: { type: 'OAUTH2', raw: { scope: grant.scope } },
      });
    }
    expect(headers.get('authorization')).toBe('Bearer proxy-test');
    expect(headers.get('connection-id')).toBe('dedicated-test');
    expect(init.method).toBe('GET');
    const path = pathname.replace('/proxy/gmail/v1/users/me/', '');
    if (revoked) return Response.json({ error: { code: 'invalid_credentials' } }, { status: 424 });
    if (path === 'profile') {
      profileReads++;
      return Response.json({ emailAddress: 'mailbox@example.test', historyId: '9007199254741001' });
    }
    if (path === 'history') {
      if (staleHistory) {
        staleHistory = false;
        return Response.json({ error: { code: 404 } }, { status: 404 });
      }
      return Response.json({ historyId: '9007199254741002' });
    }
    if (path === 'messages') {
      const ids = searchParams.get('q')?.includes('new@example.test')
        ? ['targeted']
        : ['eligible', 'ccOnly', 'targeted'];
      return Response.json({ messages: ids.map((id) => ({ id, threadId: 'thread' })) });
    }
    const message = path.split('/')[1] as keyof typeof from;
    expect(from[message]).toBeDefined();
    const full = searchParams.get('format') === 'FULL';
    if (full) fullReads.push(message);
    return Response.json({
      id: message,
      threadId: 'thread',
      labelIds: ['INBOX'],
      internalDate: String(messageDate + (message === 'targeted' ? 1 : 0)),
      payload: {
        headers: [
          { name: 'From', value: from[message] },
          {
            name: 'To',
            value: message === 'eligible' ? 'late@example.test' : 'mailbox@example.test',
          },
          { name: 'Cc', value: 'existing@example.test' },
          { name: 'Subject', value: 'Fixture conversation' },
          { name: 'Message-ID', value: `<${message}@example.test>` },
        ],
        ...(full
          ? {
              mimeType: 'text/plain',
              body: { data: Buffer.from(`Body for ${message}`).toString('base64url') },
            }
          : {}),
      },
    });
  });

  const authorize = `${base}/connections/gmail/authorize`;
  const complete = `${base}/connections/gmail/complete`;
  expect(
    (await t.request(authorize, { key: keys.member, body: { shareGmail: false, historyDays: 2 } }))
      .status,
  ).toBe(400);
  expect(
    (await t.request(authorize, { key: keys.member, body: { shareGmail: true, historyDays: 1 } }))
      .status,
  ).toBe(409);
  const attempt = await t.request(authorize, {
    key: keys.member,
    body: { shareGmail: true, historyDays: 2 },
  });
  expect(attempt.status, JSON.stringify(attempt.body)).toBe(201);
  expect(tags).toEqual({
    organization_id: workspace.id,
    end_user_id: createHash('sha256')
      .update(JSON.stringify([workspace.id, memberId]))
      .digest('hex'),
    retainer_attempt_id: attempt.body.attemptId,
  });
  const cleanupSql = db.connect({ role: 'retainer_executor' });
  const makeDue = async (attemptId: string, final = false) => {
    await db.owner`update gmail_authorization_cleanups set next_attempt_at=clock_timestamp(),
      final_check_at=case when ${final} then clock_timestamp() else final_check_at end
      where attempt_id=${attemptId}`;
  };
  const start = async (id: string) => {
    nangoConnectionId = id;
    const response = await t.request(authorize, {
      key: keys.member,
      body: { shareGmail: true, historyDays: 2 },
    });
    expect(response.status).toBe(201);
    return { attemptId: response.body.attemptId as string };
  };
  const rejected = { attemptId: attempt.body.attemptId };
  expect((await t.request(complete, { key: keys.other, body: rejected })).status).toBe(409);
  expect((await t.request(complete, { key: keys.member, body: rejected })).body.error.code).toBe(
    'gmail_scope_invalid',
  );
  expect(deleted).toEqual([]);
  await makeDue(rejected.attemptId);
  await Promise.all([cleanGmailAuthorizations(cleanupSql), cleanGmailAuthorizations(cleanupSql)]);
  expect(deleted).toEqual([]);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toEqual([]);
  await makeDue(rejected.attemptId);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toEqual(['rejected-test']);
  expect((await t.request(complete, { key: keys.member, body: rejected })).status).toBe(409);

  scope = gmailReadonly;
  const abandoned = await start('abandoned-test');
  const abandonedTags = tags;
  const racing = await start('racing-test');
  expect((await t.request(complete, { key: keys.member, body: abandoned })).status).toBe(409);
  await makeDue(abandoned.attemptId);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toContain('abandoned-test');
  // A Google callback can materialize a grant after the first cleanup pass.
  grants.set('late-test', { tags: abandonedTags, scope });
  await makeDue(abandoned.attemptId, true);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toContain('late-test');
  expect(
    await db.owner`select 1 from gmail_authorization_cleanups
    where attempt_id=${abandoned.attemptId}`,
  ).toHaveLength(0);

  const racingCompletion = t.request(complete, { key: keys.member, body: racing });
  try {
    await readingGrant.promise;
    await makeDue(racing.attemptId);
    await cleanGmailAuthorizations(cleanupSql);
  } finally {
    finishReadingGrant.resolve();
  }
  expect((await racingCompletion).status).toBe(409);
  expect(deleted).toContain('racing-test');

  const expired = await start('expired-test');
  await db.owner`update extension_authorizations set expires_at=clock_timestamp()-interval '1 second'
    where id=${expired.attemptId}`;
  expect((await t.request(complete, { key: keys.member, body: expired })).status).toBe(409);
  await makeDue(expired.attemptId);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toContain('expired-test');

  const body = await start('dedicated-test');
  const connection = await t.request(complete, { key: keys.member, body });
  expect(connection.status, JSON.stringify(connection.body)).toBe(200);
  expect((await t.request(complete, { key: keys.member, body })).status).toBe(409);
  grants.set('unused-copy-test', { tags, scope });
  await makeDue(body.attemptId, true);
  await cleanGmailAuthorizations(cleanupSql);
  expect(deleted).toContain('unused-copy-test');
  expect(deleted).not.toContain('dedicated-test');
  await runWorker('connect');

  const schedule = async () => {
    await queue.scheduleTick(workspace.id, id);
    await db.owner`update extension_schedules set next_due_at=clock_timestamp()-interval '1 second'
      where installation_id=${id} and function_id=${GMAIL.poll}`;
    await queue.scheduleTick(workspace.id, id);
  };
  const poll = async () => {
    await schedule();
    await runWorker('schedule');
    while (await jobId('job')) await runWorker('job');
  };
  await poll();
  expect(fullReads).toEqual(['eligible']);
  await addPerson('new@example.test');
  await poll();
  expect(fullReads).toEqual(['eligible', 'targeted']);
  await poll();
  expect(fullReads).toEqual(['eligible', 'targeted']);

  staleHistory = true;
  await poll();
  expect(profileReads).toBe(2);
  await poll();
  expect(
    await db.owner`select 1 from gmail_messages where workspace_id=${workspace.id}`,
  ).toHaveLength(2);

  revoked = true;
  await schedule();
  await runWorker('schedule', { status: 'failed', code: 'provider_unauthorized' });
  const status = await t.request(`${base}/connections`, { key: keys.member });
  expect(status.body.connections[0]).toMatchObject({
    health: 'needs_reconnect',
    settings: { gmailAddress: 'mailbox@example.test' },
  });

  const [evidence] = await db.owner<{ id: string }[]>`select event_id as id from gmail_messages
    where workspace_id=${workspace.id} order by occurred_at,event_id limit 1`;
  const read = await t.request(`/v1/events/${evidence?.id}/gmail-messages`, { key: keys.member });
  expect(read.status).toBe(200);
  expect(read.body.messages.map((row: { body: string }) => row.body)).toEqual([
    'Body for eligible',
    'Body for targeted',
  ]);
  const disconnected = await t.request(`${base}/connections/${connection.body.id}`, {
    key: keys.member,
    method: 'DELETE',
  });
  expect(disconnected.status).toBe(200);
  await runWorker('disconnect');
  expect(deleted.at(-1)).toBe('dedicated-test');
  expect(
    (await t.request(`/v1/events/${evidence?.id}/gmail-messages`, { key: keys.member })).body
      .messages,
  ).toHaveLength(2);
  const latePerson = await addPerson('late@example.test');
  expect(await db.owner`select 1 from event_links where record_id=${latePerson}`).toHaveLength(0);
  const forgotten = await t.request(`/v1/records/${latePerson}/forget`, {
    key: keys.admin,
    body: {},
  });
  expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(200);
  expect(
    await db.owner`select 1 from gmail_messages where workspace_id=${workspace.id}`,
  ).toHaveLength(0);
  expect(
    await db.owner`select 1 from gmail_deliveries where workspace_id=${workspace.id}`,
  ).toHaveLength(0);
  expect(
    await db.owner`select 1 from source_items where workspace_id=${workspace.id} and state='erased'`,
  ).toHaveLength(2);
});
