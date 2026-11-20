import { randomUUID } from 'node:crypto';
import type { Invocation } from '@retainer/extension';
import { executeGmail } from '@retainer/runner/gmail';
import { GMAIL, gmailManifest } from '@retainer/runner/gmail-contract';
import { generateKeyPair } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const origin = 'https://retainer.test';
const gmailReadonly = 'https://www.googleapis.com/auth/gmail.readonly';

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
      member: { actor: { type: 'user', id: 'member' }, scopes: ['read', 'write'] },
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
  };
  await addPerson('existing@example.test');
  let tags: Record<string, string> = {};
  let scope = `${gmailReadonly} https://mail.google.com/`;
  let staleHistory = false;
  let revoked = false;
  let profileReads = 0;
  let deleted = false;
  const fullReads: string[] = [];
  const messageDate = Date.now() - 3_600_000;
  const from = {
    eligible: 'existing@example.test',
    ccOnly: 'unknown@example.test',
    targeted: 'new@example.test',
  } as const;
  vi.stubEnv('RETAINER_GMAIL_NANGO_CONTROL_KEY', 'control-test');
  vi.stubEnv('RETAINER_GMAIL_NANGO_PROXY_KEY', 'proxy-test');
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
      return Response.json({
        data: {
          connect_link: 'https://connect.nango.dev/test',
          expires_at: new Date(Date.now() + 600000).toISOString(),
        },
      });
    }
    const connection = {
      connection_id: 'dedicated-test',
      provider: 'google-mail',
      provider_config_key: 'google-mail',
      tags,
    };
    if (pathname === '/connections') return Response.json({ connections: [connection] });
    if (pathname === '/connections/dedicated-test') {
      expect(headers.get('authorization')).toBe('Bearer control-test');
      expect(searchParams.get('provider_config_key')).toBe('google-mail');
      if (init.method === 'DELETE') {
        deleted = true;
        return Response.json({ success: true });
      }
      return Response.json({ ...connection, credentials: { type: 'OAUTH2', raw: { scope } } });
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
          { name: 'To', value: 'mailbox@example.test' },
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
    end_user_id: 'member',
    retainer_attempt_id: attempt.body.attemptId,
  });
  const body = { attemptId: attempt.body.attemptId };
  expect((await t.request(complete, { key: keys.other, body })).status).toBe(409);
  expect((await t.request(complete, { key: keys.member, body })).body.error.code).toBe(
    'gmail_scope_invalid',
  );
  scope = gmailReadonly;
  const connection = await t.request(complete, { key: keys.member, body });
  expect(connection.status, JSON.stringify(connection.body)).toBe(200);
  expect((await t.request(complete, { key: keys.member, body })).status).toBe(409);
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
  expect(deleted).toBe(true);
  expect(
    (await t.request(`/v1/events/${evidence?.id}/gmail-messages`, { key: keys.member })).body
      .messages,
  ).toHaveLength(2);
  const forgotten = await t.request(`/v1/records/${evidence?.id}/forget`, {
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
