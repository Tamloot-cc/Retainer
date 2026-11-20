import { randomUUID } from 'node:crypto';
import { executeRoutine } from '@retainer/runner/routine';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import type { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { RoutineExecutor, RoutineMaintenance } from '../../src/worker/routines.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import { testRunTokens } from '../helpers/model.js';

/**
 * A routine calling an extension's tool (routines spec §8, extension tools
 * spec 4), against real Postgres: the call is the extension's own job in its
 * own lane, keyed by the run and position, and only the calling run polls it.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens;
beforeAll(async () => {
  ({ tokens } = await testRunTokens());
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

async function setup() {
  const installId = randomUUID(),
    toolId = randomUUID();
  const manifest = extensionFixture({
    scopes: ['read'],
    functions: [
      {
        universalId: installId,
        name: 'setup',
        description: 'Tool fixture setup',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 60,
        trigger: { kind: 'install' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
      {
        universalId: toolId,
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
    ]),
    release = catalog.get(manifest.universalId, manifest.version);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    runTokens: tokens,
    routines: { modelAvailable: false },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Routine tools ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin', name: 'Ada' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: plan.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const [pending] = await db.owner`
    select id from extension_jobs where installation_id=${installed.body.id} and trigger_kind='install'`;
  const setupRun = await queue.claim(workspace.id, pending?.id, 'setup');
  if (!setupRun) throw new Error('setup missing');
  await queue.complete(setupRun, { status: 'succeeded' });
  const executor = new RoutineExecutor({
    sql: app.sql,
    discoverySql: db.connect({ role: 'retainer_executor', max: 1 }),
    tokens,
    driver: {
      invoke: (_e, invocation, signal) => executeRoutine(invocation, signal, app.inProcessFetch),
    },
    executable: { releaseDigest: 'a'.repeat(64) } as never,
    apiOrigin: 'http://retainer.test/',
    owner: 'test-executor',
    config: { catalog: catalog.runtime, modelAvailable: false },
  });
  // A manual routine that calls the tool, validated and approved.
  const source = {
    manifest: {
      when: { kind: 'manual', object: 'company', label: 'Check' },
      uses: { tools: ['check_address'], model: false },
    },
    code: `export async function main({ retainer }: RoutineContext<'company'>) {
  const { deliverable } = await retainer.tools.check_address({ address: 'ada@example.com' });
  return { deliverable };
}
`,
  };
  const validated = await app.request('/v1/routines/validate', { key: keys.admin, body: source });
  expect(validated.body.problems).toEqual([]);
  await executor.tick();
  const proposed = await app.request('/v1/routines', {
    key: keys.admin,
    body: {
      ...source,
      name: 'Check addresses',
      description: 'Check the address.',
      summary: 'Checks an address.',
      report: { verdict: 'full', gaps: [] },
    },
  });
  expect(proposed.status).toBe(201);
  const { routineId, versionId } = proposed.body;
  expect(
    (
      await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
        key: keys.admin,
        body: {},
      })
    ).status,
  ).toBe(200);
  const company = await app.request('/v1/objects/company/records', {
    key: keys.admin,
    body: { values: { name: 'Acme' } },
  });
  const press = async (recordId: string = company.body.id) => {
    const pressed = await app.request(`/v1/routines/${routineId}/run`, {
      key: keys.admin,
      body: { recordIds: [recordId] },
    });
    expect(pressed.status).toBe(202);
    const claimed = await executor.claim(workspace.id, pressed.body.runs[0]);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      workspace.id,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'run', tools: claimed.tools },
      new Date(Date.now() + 60000),
    );
    return { runId: claimed.runId, token };
  };
  const another = async () =>
    (
      await app.request('/v1/objects/company/records', {
        key: keys.admin,
        body: { values: { name: 'Globex' } },
      })
    ).body.id as string;
  return { app, workspace: workspace.id, keys, queue, routineId, press, another };
}

describe('routine tool calls', () => {
  it('queues the tool as its own job, and only the calling run polls its output', async () => {
    const s = await setup();
    const { runId, token } = await s.press();
    const effect = (body: unknown, key = token) =>
      s.app.request('/v1/routines/runtime/effects', { key, body });
    const notListed = await effect({
      position: 1,
      operation: 'tool',
      args: { name: 'send_email', input: {} },
    });
    expect(notListed.body.error.code).toBe('tool_not_listed');
    // The refusal keeps position 1, so the call is the second.
    const call = {
      position: 2,
      operation: 'tool',
      args: { name: 'check_address', input: { address: 'ada@example.com' } },
    };
    const started = await effect(call);
    expect(started.body).toMatchObject({ state: 'pending', tool: { callId: expect.any(String) } });
    // Asked again (a retried run), the same call comes back: nothing is queued twice.
    expect((await effect(call)).body.tool.callId).toBe(started.body.tool.callId);
    const jobs = await db.owner<
      { id: string; trigger_kind: string; caller_run_id: string; dedupe_key: string }[]
    >`
      select id,trigger_kind,caller_run_id,dedupe_key from extension_jobs where trigger_kind='tool'`;
    expect(jobs).toEqual([
      {
        id: started.body.tool.callId,
        trigger_kind: 'tool',
        caller_run_id: runId,
        dedupe_key: `routine:${runId}:2`,
      },
    ]);
    expect((await s.app.request('/v1/routines/runtime/effects/2', { key: token })).body.state).toBe(
      'pending',
    );
    // The extension runs it and answers within its output schema.
    const lease = await s.queue.claim(s.workspace, started.body.tool.callId, 'tool-runner');
    if (!lease) throw new Error('tool job not claimed');
    await s.queue.complete(lease, { status: 'succeeded', output: { deliverable: true } });
    const polled = await s.app.request('/v1/routines/runtime/effects/2', { key: token });
    expect(polled.body).toEqual({ state: 'done', result: { deliverable: true }, replayed: false });
    // Another run cannot read this call's output.
    const other = await s.press(await s.another());
    expect(
      (await s.app.request('/v1/routines/runtime/effects/2', { key: other.token })).status,
    ).toBe(404);
  });

  it('output outside the schema fails the call', async () => {
    const s = await setup();
    const { token } = await s.press();
    const started = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 'x@y.z' } },
      },
    });
    const lease = await s.queue.claim(s.workspace, started.body.tool.callId, 'tool-runner');
    if (!lease) throw new Error('tool job not claimed');
    await s.queue.complete(lease, { status: 'succeeded', output: { deliverable: 'yes' } });
    const polled = await s.app.request('/v1/routines/runtime/effects/1', { key: token });
    expect(polled.body.error.code).toBe('invalid_output');
    // The failure is recorded, so a retry gets it without reading the job again.
    const [result] = await db.owner<{ state: string; code: string }[]>`
      select state,code from routine_run_results where tool_job_id=${started.body.tool.callId}`;
    expect(result).toEqual({ state: 'failed', code: 'invalid_output' });
  });

  it("a tool called near the end of an attempt ends by the attempt's deadline", async () => {
    const s = await setup();
    const { runId, token } = await s.press();
    // Five seconds of this attempt are left (the lease runs 15 s past its deadline).
    await db.owner`update routine_runs set lease_until=clock_timestamp()+interval '20 seconds' where id=${runId}`;
    const started = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 'x@y.z' } },
      },
    });
    const [bounds] = await db.owner<{ expires_at: Date; deadline: Date; run_expires_at: Date }[]>`
      select j.expires_at,r.lease_until-interval '15 seconds' as deadline,r.expires_at as run_expires_at
      from extension_jobs j join routine_runs r on r.id=j.caller_run_id where j.id=${started.body.tool.callId}`;
    // Not the run's 24-hour expiry: this attempt's deadline.
    expect(bounds?.expires_at.getTime()).toBe(bounds?.deadline.getTime());
    expect(bounds?.expires_at.getTime()).toBeLessThan(bounds?.run_expires_at.getTime() ?? 0);
    // Claimed now, the handler gets the time left, not its full timeout.
    const lease = await s.queue.claim(s.workspace, started.body.tool.callId, 'tool-runner');
    if (!lease) throw new Error('tool job not claimed');
    expect(lease.deadline.getTime()).toBeLessThanOrEqual(bounds?.expires_at.getTime() ?? 0);
    expect(lease.deadline.getTime() - Date.now()).toBeLessThan(6000);
  });

  it('a tool changed after the run started is refused, and the routine pauses', async () => {
    const s = await setup();
    const { runId, token } = await s.press();
    // The extension was upgraded mid-run: the installed tool no longer matches the pin.
    await db.owner`update routine_versions v set tool_contracts=jsonb_set(v.tool_contracts,'{check_address,effect}','"send"')
      from routine_runs r where r.id=${runId} and v.id=r.version_id`;
    const refused = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 'x@y.z' } },
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('tool_changed');
    const jobs = await db.owner`select 1 from extension_jobs where caller_run_id=${runId}`;
    expect(jobs).toHaveLength(0);
    const routine = await s.app.request(`/v1/routines/${s.routineId}`, { key: s.keys.admin });
    expect(routine.body).toMatchObject({ status: 'needs_attention', pausedReason: 'tool_changed' });
  });

  it("a tool job does not start once its caller's routine is paused", async () => {
    const s = await setup();
    const { token } = await s.press();
    const started = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 'x@y.z' } },
      },
    });
    await s.app.request(`/v1/routines/${s.routineId}/pause`, { key: s.keys.admin, body: {} });
    expect(await s.queue.claim(s.workspace, started.body.tool.callId, 'tool-runner')).toBe(null);
    const [job] = await db.owner<{ status: string; code: string }[]>`
      select status,code from extension_jobs where id=${started.body.tool.callId}`;
    expect(job).toEqual({ status: 'cancelled', code: 'caller_stopped' });
  });

  it("forget redacts a routine's tool jobs, and retention clears them after 7 days", async () => {
    const s = await setup();
    const { runId, token } = await s.press();
    const call = (position: number, address: string) =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: { position, operation: 'tool', args: { name: 'check_address', input: { address } } },
      });
    const done = await call(1, 'done@example.com');
    const lease = await s.queue.claim(s.workspace, done.body.tool.callId, 'tool-runner');
    if (!lease) throw new Error('tool job not claimed');
    await s.queue.complete(lease, { status: 'succeeded', output: { deliverable: true } });
    const waiting = await call(2, 'waiting@example.com');
    const doomed = await s.another();
    const forgot = await s.app.request(`/v1/records/${doomed}/forget`, {
      key: s.keys.admin,
      method: 'POST',
    });
    expect(forgot.status).toBe(200);
    const jobs = await db.owner<
      { id: string; status: string; code: string | null; input: unknown; output: unknown }[]
    >`
      select id,status,code,input,output from extension_jobs where caller_run_id=${runId}`;
    const byId = Object.fromEntries(jobs.map(({ id, ...rest }) => [id, rest]));
    expect(byId).toEqual({
      [done.body.tool.callId]: { status: 'succeeded', code: null, input: {}, output: null },
      [waiting.body.tool.callId]: {
        status: 'cancelled',
        code: 'privacy_erased',
        input: {},
        output: null,
      },
    });
    // Retention: a finished run's tool payloads go after 7 days.
    const second = await s.press(await s.another());
    const kept = await s.app.request('/v1/routines/runtime/effects', {
      key: second.token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 'k@x.y' } },
      },
    });
    const keptLease = await s.queue.claim(s.workspace, kept.body.tool.callId, 'tool-runner');
    if (!keptLease) throw new Error('tool job not claimed');
    await s.queue.complete(keptLease, { status: 'succeeded', output: { deliverable: false } });
    // A third run timed out with its tool job never run (no extension executor).
    const third = await s.press(await s.another());
    const stranded = await s.app.request('/v1/routines/runtime/effects', {
      key: third.token,
      body: {
        position: 1,
        operation: 'tool',
        args: { name: 'check_address', input: { address: 's@x.y' } },
      },
    });
    await db.owner`update routine_runs set status='succeeded',lease_owner=null,lease_until=null,
      finished_at=now()-interval '8 days' where id=${second.runId}`;
    await db.owner`update routine_runs set status='failed',code='run_timeout',lease_owner=null,lease_until=null,
      finished_at=now()-interval '8 days' where id=${third.runId}`;
    await new RoutineMaintenance(
      s.app.sql,
      db.connect({ role: 'retainer_executor', max: 1 }),
    ).maintain();
    const [cleared] = await db.owner<{ input: unknown; output: unknown }[]>`
      select input,output from extension_jobs where id=${kept.body.tool.callId}`;
    expect(cleared).toEqual({ input: {}, output: null });
    const [cancelled] = await db.owner<{ status: string; input: unknown }[]>`
      select status,input from extension_jobs where id=${stranded.body.tool.callId}`;
    expect(cancelled).toEqual({ status: 'cancelled', input: {} });
  });
});
