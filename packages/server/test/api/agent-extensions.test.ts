import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

/**
 * Extension `read` tools in a chat (agent spec §8.1, §8.3), against real
 * Postgres: a chat pins the tools installed when it is created, an install
 * later reaches only new chats and leaves an existing chat's tools block
 * byte-identical, and a tool call runs as the extension's own job, answering
 * `pending` while it runs and its result once it finishes.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

async function setup() {
  const manifest = extensionFixture({
    scopes: ['read'],
    functions: [
      {
        universalId: randomUUID(),
        name: 'setup',
        description: 'Tool fixture setup',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 60,
        trigger: { kind: 'install' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
      {
        universalId: randomUUID(),
        name: 'check_address',
        description: 'Checks whether an address is deliverable.',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 60,
        trigger: {
          kind: 'tool',
          title: 'Check an address',
          effect: 'read',
          connection: 'workspace',
          outputSchema: {
            type: 'object',
            properties: { deliverable: { type: 'boolean' } },
            required: ['deliverable'],
            additionalProperties: false,
          },
        },
        inputSchema: {
          type: 'object',
          properties: { address: { type: 'string' } },
          required: ['address'],
          additionalProperties: false,
        },
      },
    ],
  });
  const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]);
  const release = catalog.get(manifest.universalId, manifest.version);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url, extensionWaitMs: 300 },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Agent tools ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin', name: 'Ada' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const queue = new ExtensionQueue(app.sql, catalog.runtime);

  const install = async () => {
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
    const installed = await app.request('/v1/extensions', {
      key: keys.admin,
      body: { ...input, planDigest: plan.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status).toBe(201);
    const [pending] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where installation_id=${installed.body.id} and trigger_kind='install'`;
    const run = await queue.claim(workspace.id, pending?.id ?? '', 'setup');
    if (!run) throw new Error('setup missing');
    await queue.complete(run, { status: 'succeeded' });
  };
  const newChat = async () => {
    const res = await app.request<{ id: string }>('/v1/agent/chats', {
      key: keys.admin,
      method: 'POST',
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };
  /** Claims a turn and returns its token and the tools block, exactly as sent. */
  const claim = async (id: string) => {
    const minted = await app.request<{ token: string }>(`/v1/agent/chats/${id}/token`, {
      key: keys.admin,
      method: 'POST',
    });
    const res = await app.request(`/v1/agent/runtime/sessions/${id}/claim`, {
      key: RUNTIME_SECRET,
      body: { streamToken: minted.body.token },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      turnToken: res.body.turnToken as string,
      tools: JSON.stringify(res.body.session.tools),
      names: (res.body.session.tools as { name: string }[]).map((tool) => tool.name),
    };
  };
  const close = (id: string, turnToken: string) =>
    app.request(`/v1/agent/runtime/sessions/${id}/close`, {
      key: turnToken,
      body: { status: 'completed', errorCode: null, durationMs: 1 },
    });
  return { app, workspace, queue, install, newChat, claim, close };
}

describe('extension read tools in a chat', () => {
  it('keeps an existing chat’s tools block byte-identical across an install', async () => {
    const { install, newChat, claim, close } = await setup();
    const before = await newChat();
    const first = await claim(before);
    expect(first.names).not.toContain('ext_check_address');
    expect((await close(before, first.turnToken)).status).toBe(200);

    await install();

    const second = await claim(before);
    expect(second.tools).toBe(first.tools);
    expect((await close(before, second.turnToken)).status).toBe(200);

    // A chat created after the install gets the tool, after the web tools.
    const after = await claim(await newChat());
    expect(after.names.slice(-3)).toEqual(['web_search', 'web_fetch', 'ext_check_address']);
  });

  it('runs a call as the extension’s job: pending while it runs, then its output', async () => {
    const { app, workspace, queue, install, newChat, claim } = await setup();
    await install();
    const id = await newChat();
    const { turnToken } = await claim(id);
    const call = () =>
      app.request(`/v1/agent/runtime/sessions/${id}/tools/ext_check_address`, {
        key: turnToken,
        body: { toolCallId: 'toolu_1', input: { address: '1 Main St' } },
      });

    const pending = await call();
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ pending: true });
    // Asking again with the same tool call ID finds the same job.
    expect((await call()).body).toEqual({ pending: true });
    const jobs = await db.owner<{ id: string; trigger_kind: string }[]>`
      select id, trigger_kind from extension_jobs
      where workspace_id=${workspace.id} and trigger_kind <> 'install'`;
    expect(jobs).toHaveLength(1);

    const run = await queue.claim(workspace.id, jobs[0]?.id ?? '', 'tool-runner');
    if (!run) throw new Error('tool job not claimable');
    await queue.complete(run, { status: 'succeeded', output: { deliverable: true } });

    const done = await call();
    expect(done.body).toEqual({ ok: true, output: { deliverable: true } });

    // A different call is a different job; a tool the chat doesn't pin is refused.
    const other = await app.request(`/v1/agent/runtime/sessions/${id}/tools/ext_nope`, {
      key: turnToken,
      body: { toolCallId: 'toolu_2', input: {} },
    });
    expect(other.body).toMatchObject({ ok: false, error: { code: 'tool_not_available' } });
  });

  it('answers a failed job as the tool’s error result', async () => {
    const { app, workspace, queue, install, newChat, claim } = await setup();
    await install();
    const id = await newChat();
    const { turnToken } = await claim(id);
    const call = () =>
      app.request(`/v1/agent/runtime/sessions/${id}/tools/ext_check_address`, {
        key: turnToken,
        body: { toolCallId: 'toolu_9', input: { address: 'nowhere' } },
      });
    expect((await call()).body).toEqual({ pending: true });
    const [job] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where workspace_id=${workspace.id} and trigger_kind <> 'install'`;
    const run = await queue.claim(workspace.id, job?.id ?? '', 'tool-runner');
    if (!run) throw new Error('tool job not claimable');
    await queue.complete(run, { status: 'failed', code: 'provider_down' });
    expect((await call()).body).toMatchObject({ ok: false, error: { code: 'provider_down' } });
  });
});
