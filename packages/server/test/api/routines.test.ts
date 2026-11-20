import { randomUUID } from 'node:crypto';
import { executeRoutine } from '@retainer/runner/routine';
import { ROUTINE_LIMITS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { dispatchRoutines } from '../../src/routines/matcher.js';
import {
  type RoutineDriver,
  RoutineExecutor,
  RoutineMaintenance,
} from '../../src/worker/routines.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * Routines end to end (routines spec §11.2): REST in, the real executor, the
 * real routine runner in its sandbox, and the runtime API it calls, all
 * against real Postgres. Only the transport is in-process.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'routines',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

async function setup(
  options: { modelCallsPerDay?: number; driver?: (app: TestApp) => RoutineDriver } = {},
) {
  const app = startTestApp(db, {
    runTokens: tokens,
    routines: {
      modelAvailable: true,
      modelOrigin: 'http://model.test/',
      modelName: 'claude-opus-5-5',
      modelCallsPerDay: options.modelCallsPerDay ?? 1000,
    },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Routines ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin', name: 'Ada Admin' }, scopes: ['admin'] },
      agent: {
        actor: { type: 'agent', id: 'agent:builder', name: 'Builder' },
        scopes: ['read', 'write'],
      },
    },
  );
  workspaces.push(workspace.id);
  const schema = await app.request('/v1/schema/changes', {
    key: keys.admin,
    body: {
      operations: [
        {
          op: 'create_field',
          object: 'company',
          field: { name: 'tier', label: 'Tier', type: 'text' },
        },
      ],
      reason: 'Routine tests',
    },
  });
  expect(schema.status).toBe(200);
  const caps = await app.request('/v1/routines/capabilities', { key: keys.agent });
  expect(caps.status).toBe(200);
  const company = caps.body.objects.find((o: { name: string }) => o.name === 'company');
  const key = (name: string) =>
    company.fields.find((f: { name: string }) => f.name === name).key as string;
  const executor = new RoutineExecutor({
    sql: app.sql,
    discoverySql: db.connect({ role: 'retainer_executor', max: 1 }),
    tokens,
    driver: options.driver?.(app) ?? {
      invoke: (_exe, invocation, signal) => executeRoutine(invocation, signal, app.inProcessFetch),
    },
    executable: {
      registrationId: randomUUID(),
      functionId: randomUUID(),
      releaseDigest: 'a'.repeat(64),
      driverTarget: 'routine-runner',
    } as never,
    apiOrigin: 'http://retainer.test/',
    owner: 'test-executor',
    config: { modelAvailable: true },
  });
  const maintenance = new RoutineMaintenance(
    app.sql,
    db.connect({ role: 'retainer_executor', max: 1 }),
  );
  return { app, workspace: workspace.id, keys, caps: caps.body, key, executor, maintenance };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const TIER_ROUTINE = (tier: string, name: string) => ({
  manifest: {
    when: { kind: 'record', object: 'company', on: ['created'] },
    if: { [name]: { contains: 'Acme' } },
    uses: { tools: [], model: false },
  },
  code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'gold' });
  return { tiered: record.id };
}
`,
});

/** Validates (running the sandbox check), proposes as the agent and approves as the admin. */
async function activate(s: Setup, source: { manifest: unknown; code: string }) {
  const { app, keys, executor } = s;
  const validated = await app.request('/v1/routines/validate', { key: keys.agent, body: source });
  expect(validated.status).toBe(200);
  expect(validated.body.problems).toEqual([]);
  if (validated.body.valid === null) {
    await executor.tick();
    const job = await app.request(`/v1/routines/jobs/${validated.body.jobId}`, { key: keys.agent });
    if (job.body.valid !== true) console.error(JSON.stringify(job.body));
    expect(job.body).toMatchObject({ valid: true, problems: [] });
  }
  const proposed = await app.request('/v1/routines', {
    key: keys.agent,
    body: {
      ...source,
      name: 'Tier Acme companies',
      description: 'When a company called Acme is created, set its tier to gold.',
      summary: 'Sets new Acme companies to the gold tier.',
      report: { verdict: 'full', gaps: [] },
    },
  });
  expect(proposed.status).toBe(201);
  const { routineId, versionId } = proposed.body;
  const refused = await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
    key: keys.agent,
    body: {},
  });
  expect(refused.status).toBe(403);
  const approved = await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
    key: keys.admin,
    body: {},
  });
  expect(approved.status).toBe(200);
  return { routineId: routineId as string, versionId: versionId as string };
}

async function createCompany(app: TestApp, key: string, name: string) {
  const created = await app.request('/v1/objects/company/records', {
    key,
    body: { values: { name } },
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

/** Starts a test run on one record and returns its token, to drive the runtime by hand. */
async function drive(s: Setup, routineId: string, versionId: string, recordId: string) {
  const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
    key: s.keys.admin,
    body: { recordId },
  });
  const claimed = await s.executor.claim(s.workspace, tested.body.runId);
  if (!claimed) throw new Error('run not claimed');
  const token = await tokens.issueRoutine(
    s.workspace,
    { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'test', tools: [] },
    new Date(Date.now() + 60000),
  );
  const effect = (position: number, operation: string, args: Record<string, unknown>) =>
    s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: { position, operation, args },
    });
  return { runId: claimed.runId, token, effect };
}

describe('routines', () => {
  it('reports manifest problems as fixed logic, before anything runs', async () => {
    const { app, keys } = await setup();
    const res = await app.request('/v1/routines/validate', {
      key: keys.agent,
      body: {
        manifest: {
          when: { kind: 'schedule', cron: '* * * * *', object: 'nothing' },
          uses: { tools: ['send_email'], model: false },
        },
        code: 'export const x = 1;\n',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.problems.map((p: { code: string }) => p.code).sort()).toEqual(
      ['missing_main', 'no_tool', 'over_limit', 'unknown_object'].sort(),
    );
  });

  it("the sandbox check refuses a main typed for another object than the trigger's", async () => {
    const s = await setup();
    const validated = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'person'>) {
  return record.id;
}
`,
      },
    });
    expect(validated.body.valid).toBe(null);
    await s.executor.tick();
    const job = await s.app.request(`/v1/routines/jobs/${validated.body.jobId}`, {
      key: s.keys.agent,
    });
    expect(job.body.valid).toBe(false);
    expect(job.body.problems.map((p: { code: string }) => p.code)).toEqual(['missing_main']);
  });

  it('a type error fails the sandbox check, with its position', async () => {
    const s = await setup();
    const res = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {\n  const n: number = record.id;\n  return n;\n}\n`,
      },
    });
    expect(res.body.valid).toBe(null);
    await s.executor.tick();
    const job = await s.app.request(`/v1/routines/jobs/${res.body.jobId}`, { key: s.keys.agent });
    expect(job.body).toMatchObject({
      valid: false,
      problems: [expect.objectContaining({ at: '2:9', code: 'TS2322' })],
    });
    const proposed = await s.app.request('/v1/routines', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {\n  const n: number = record.id;\n  return n;\n}\n`,
        name: 'x',
        description: 'x',
        summary: 'x',
        report: { verdict: 'full', gaps: [] },
      },
    });
    expect(proposed.status).toBe(409);
  });

  it('runs an approved routine on matching records only, writing as the routine', async () => {
    const s = await setup();
    const { routineId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Corp');
    const other = await createCompany(s.app, s.keys.admin, 'Other Inc');
    await s.maintenance.maintain();
    await s.executor.tick();
    const record = async (id: string) =>
      (await s.app.request(`/v1/records/${id}`, { key: s.keys.admin })).body;
    expect((await record(acme)).fields.tier).toBe('gold');
    expect((await record(other)).fields.tier ?? null).toBe(null);
    const runs = await db.owner<{ record_id: string; status: string; code: string | null }[]>`
      select record_id,status,code from routine_runs where routine_id=${routineId} order by created_at`;
    expect(runs).toEqual(
      expect.arrayContaining([
        { record_id: acme, status: 'succeeded', code: null },
        { record_id: other, status: 'skipped', code: 'condition_false' },
      ]),
    );
    const [assertion] = await db.owner<{ actor: { type: string; id: string; name: string } }[]>`
      select a.actor from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='tier'`;
    expect(assertion?.actor).toMatchObject({ type: 'agent', id: routineId });
    expect(assertion?.actor.name).toContain('Tier Acme companies (routine, version 1');
    // Its own write does not trigger it again.
    await s.maintenance.maintain();
    const [count] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from routine_runs where routine_id=${routineId}`;
    expect(count?.n).toBe(2);
  });

  it('a run interrupted mid-loop is retried and ends with each write made once', async () => {
    let crashed = true;
    const s = await setup({
      driver: (app) => ({
        invoke: async (_exe, invocation, signal) => {
          if (crashed) return executeRoutine(invocation, signal, app.inProcessFetch);
          // The first attempt dies after its third write, like a lost container.
          crashed = true;
          const stop = new AbortController();
          let writes = 0;
          const transport = (async (url: string | URL | Request, init?: RequestInit) => {
            const response = await app.inProcessFetch(url, init);
            if (String(url).endsWith('/runtime/effects') && ++writes === 3) stop.abort();
            return response;
          }) as typeof fetch;
          await executeRoutine(invocation, AbortSignal.any([signal, stop.signal]), transport).catch(
            () => {},
          );
          throw new Error('the runner died');
        },
      }),
    });
    const tier = s.key('tier');
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Ten' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  for (let i = 0; i < 10; i++) await retainer.company.create({ name: record.id + ' #' + i });
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'done' });
  return 'ok';
}
`,
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Loop');
    crashed = false;
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    const runId = pressed.body.runs[0] as string;
    await s.executor.tick();
    const [after] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${runId}`;
    expect(after?.status).toBe('queued');
    await db.owner`update routine_runs set available_at=now() where id=${runId}`;
    await s.executor.tick();
    const [run] = await db.owner<{ status: string; attempt: number }[]>`
      select status,attempt from routine_runs where id=${runId}`;
    expect(run).toEqual({ status: 'succeeded', attempt: 2 });
    const made = await s.app.request('/v1/objects/company/query', {
      key: s.keys.admin,
      body: { filter: { name: { contains: `${acme} #` } }, limit: 100 },
    });
    expect(made.body.records).toHaveLength(10);
  });

  it("a routine's write to a value a person set waits for review", async () => {
    const s = await setup();
    const tier = s.key('tier');
    await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const created = await s.app.request('/v1/objects/company/records', {
      key: s.keys.admin,
      body: { values: { name: 'Acme Ranked', tier: 'silver' } },
    });
    await s.maintenance.maintain();
    await s.executor.tick();
    const record = await s.app.request(`/v1/records/${created.body.id}`, { key: s.keys.admin });
    expect(record.body.fields.tier).toBe('silver');
  });

  it('approving a new version discards runs not yet started', async () => {
    const s = await setup();
    const source = TIER_ROUTINE(s.key('tier'), s.key('name'));
    const { routineId } = await activate(s, source);
    await createCompany(s.app, s.keys.admin, 'Acme Waiting');
    await s.maintenance.maintain();
    const v2 = await s.app.request('/v1/routines', {
      key: s.keys.agent,
      body: {
        ...source,
        routineId,
        name: 'Tier Acme companies',
        description: 'Version two.',
        summary: 'Sets new Acme companies to the gold tier.',
        report: { verdict: 'full', gaps: [] },
      },
    });
    expect(v2.status).toBe(201);
    const approved = await s.app.request(
      `/v1/routines/${routineId}/versions/${v2.body.versionId}/approve`,
      { key: s.keys.admin, body: {} },
    );
    expect(approved.body.discardedRuns).toBe(1);
    const runs = await db.owner<{ status: string }[]>`
      select status from routine_runs where routine_id=${routineId}`;
    expect(runs.map((r) => r.status)).toEqual(['discarded']);
  });

  it('removing a field only the `if` uses fails the run and pauses the routine', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Go' },
        if: { [s.key('tier')]: { contains: 'gold' } },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme If');
    const removed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [{ op: 'delete_field', object: 'company', field: 'tier' }],
        reason: 'gone',
      },
    });
    expect(removed.status).toBe(200);
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    expect(pressed.status).toBe(202);
    // The claim does not throw and leave the run queued: it fails it once.
    expect(await s.executor.claim(s.workspace, pressed.body.runs[0])).toBe(null);
    const [run] = await db.owner<{ status: string; code: string }[]>`
      select status,code from routine_runs where id=${pressed.body.runs[0]}`;
    expect(run).toEqual({ status: 'failed', code: 'check_failed' });
    const routine = await s.app.request(`/v1/routines/${routineId}`, { key: s.keys.admin });
    expect(routine.body).toMatchObject({ status: 'needs_attention', pausedReason: 'check_failed' });
  });

  it('a schedule whose filter field or object is removed pauses instead of failing each tick', async () => {
    const s = await setup();
    const segment = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'site',
              namePlural: 'sites',
              labelSingular: 'Site',
              labelPlural: 'Sites',
              labelField: 'title',
              fields: [
                { name: 'title', label: 'Title', type: 'text' },
                { name: 'region', label: 'Region', type: 'text' },
              ],
            },
          },
        ],
        reason: 'Routine tests',
      },
    });
    expect(segment.status).toBe(200);
    const caps = await s.app.request('/v1/routines/capabilities', { key: s.keys.agent });
    const site = caps.body.objects.find((o: { name: string }) => o.name === 'site');
    const region = site.fields.find((f: { name: string }) => f.name === 'region').key;
    const schedule = (filter?: Record<string, unknown>) =>
      activate(s, {
        manifest: {
          when: {
            kind: 'schedule',
            cron: '0 9 * * 1',
            object: 'site',
            ...(filter ? { filter } : {}),
          },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'site'>) {
  return record.id;
}
`,
      });
    const byFilter = await schedule({ [region]: { contains: 'EU' } });
    const byObject = await schedule();
    const remove = (operations: unknown[]) =>
      s.app.request('/v1/schema/changes', {
        key: s.keys.admin,
        body: { operations, reason: 'gone' },
      });
    expect((await remove([{ op: 'delete_field', object: 'site', field: 'region' }])).status).toBe(
      200,
    );
    await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${byFilter.routineId}`;
    await s.maintenance.maintain();
    expect((await remove([{ op: 'delete_object', object: 'site' }])).status).toBe(200);
    await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${byObject.routineId}`;
    await s.maintenance.maintain();
    const routines = await db.owner<{ status: string; paused_reason: string }[]>`
      select status,paused_reason from routines where id=any(${[byFilter.routineId, byObject.routineId]}::uuid[])`;
    expect(routines).toEqual([
      { status: 'needs_attention', paused_reason: 'check_failed' },
      { status: 'needs_attention', paused_reason: 'check_failed' },
    ]);
  });

  it('an object whose name the SDK uses is not offered to routines', async () => {
    const s = await setup();
    const created = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'tools',
              namePlural: 'toolsList',
              labelSingular: 'Tool',
              labelPlural: 'Tools',
              labelField: 'title',
              fields: [{ name: 'title', label: 'Title', type: 'text' }],
            },
          },
        ],
        reason: 'Routine tests',
      },
    });
    expect(created.status).toBe(200);
    const caps = await s.app.request('/v1/routines/capabilities', { key: s.keys.agent });
    expect(caps.body.objects.map((o: { name: string }) => o.name)).not.toContain('tools');
    const res = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'tools', label: 'Go' },
          uses: { tools: ['then'], model: false },
        },
        code: 'export async function main() {}\n',
      },
    });
    expect(res.body.problems.map((p: { code: string }) => p.code).sort()).toEqual([
      'invalid_manifest',
    ]);
    const reserved = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'tools', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: 'export async function main() {}\n',
      },
    });
    expect(reserved.body.problems.map((p: { code: string }) => p.code)).toEqual([
      'reserved_object',
    ]);
  });

  it('a filter field made non-filterable pauses the routine, in the `if` and in a schedule', async () => {
    const s = await setup();
    const tierFilter = { [s.key('tier')]: { eq: 'gold' } };
    const code = `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`;
    const manual = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Go' },
        if: tierFilter,
        uses: { tools: [], model: false },
      },
      code,
    });
    const scheduled = await activate(s, {
      manifest: {
        when: { kind: 'schedule', cron: '0 9 * * 1', object: 'company', filter: tierFilter },
        uses: { tools: [], model: false },
      },
      code,
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Unfilterable');
    const changed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [{ op: 'update_field', object: 'company', field: 'tier', isFilterable: false }],
        reason: 'not filterable',
      },
    });
    expect(changed.status).toBe(200);
    const pressed = await s.app.request(`/v1/routines/${manual.routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    expect(await s.executor.claim(s.workspace, pressed.body.runs[0])).toBe(null);
    await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${scheduled.routineId}`;
    expect((await s.maintenance.maintain()).failed).toBe(0);
    const [run] = await db.owner<{ status: string; code: string }[]>`
      select status,code from routine_runs where id=${pressed.body.runs[0]}`;
    expect(run).toEqual({ status: 'failed', code: 'check_failed' });
    const routines = await db.owner<{ status: string; paused_reason: string }[]>`
      select status,paused_reason from routines where id=any(${[manual.routineId, scheduled.routineId]}::uuid[])`;
    expect(routines).toEqual([
      { status: 'needs_attention', paused_reason: 'check_failed' },
      { status: 'needs_attention', paused_reason: 'check_failed' },
    ]);
  });

  it('a preview counts every recent matching change, past the sample it reads', async () => {
    const s = await setup();
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Busy');
    // 5,100 matching changes: more than the preview ever read, and than its sample.
    await db.owner`insert into record_changes(workspace_id,position,record_id,object_type_id,operation,field_keys,cause,cause_depth,created_at)
      select c.workspace_id,c.position+1000000+g,c.record_id,c.object_type_id,'create',c.field_keys,c.cause,c.cause_depth,c.created_at
      from record_changes c, generate_series(1,5100) g where c.record_id=${acme} and c.operation='create'`;
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBeGreaterThan(5100);
  });

  it('removing a watched field pauses a record routine instead of leaving it deaf', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'record', object: 'company', on: ['updated'], fields: [s.key('tier')] },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
    });
    const removed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [{ op: 'delete_field', object: 'company', field: 'tier' }],
        reason: 'gone',
      },
    });
    expect(removed.status).toBe(200);
    await createCompany(s.app, s.keys.admin, 'Acme Deaf');
    await s.maintenance.maintain();
    const routine = await s.app.request(`/v1/routines/${routineId}`, { key: s.keys.admin });
    expect(routine.body).toMatchObject({ status: 'needs_attention', pausedReason: 'check_failed' });
  });

  it('code filters and sorts on event columns, and writes a field keyed source', async () => {
    const s = await setup();
    const added = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: { name: 'source', label: 'Source', type: 'text' },
          },
        ],
        reason: 'Routine tests',
      },
    });
    expect(added.status).toBe(200);
    expect(s.key('tier')).toBeTruthy();
    const caps = await s.app.request('/v1/routines/capabilities', { key: s.keys.agent });
    const company = caps.body.objects.find((o: { name: string }) => o.name === 'company');
    expect(company.fields.map((f: { key: string }) => f.key)).toContain('source');
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Go' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  const recent = await retainer.conversation.query({
    filter: { occurredAt: { gt: '2000-01-01T00:00:00Z' }, channel: { eq: 'gmail' } },
    sort: [{ field: 'occurredAt', direction: 'desc' }],
  });
  await retainer.company.update(record.id, { source: 'web' });
  return recent.count;
}
`,
    });
    await s.app.request('/v1/events', {
      key: s.keys.admin,
      body: {
        type: 'conversation',
        channel: 'gmail',
        occurredAt: '2026-11-10T10:00:00Z',
        title: 'Hi',
      },
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Source');
    const ran = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    const claimed = await s.executor.claim(s.workspace, ran.body.runs[0]);
    await s.executor.execute(claimed as NonNullable<typeof claimed>);
    const [run] = await db.owner<{ status: string; output: { result: unknown } }[]>`
      select status,output from routine_runs where id=${ran.body.runs[0]}`;
    expect(run).toMatchObject({ status: 'succeeded', output: { result: 1 } });
    const record = await s.app.request(`/v1/records/${acme}`, { key: s.keys.admin });
    expect(record.body.fields.source).toBe('web');
  });

  it('a preview with nothing to dry-run is done at once, with no ID to poll', async () => {
    const s = await setup();
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.body).toMatchObject({
      valid: true,
      previewId: null,
      matched: 0,
      runs: [],
      done: true,
    });
  });

  it("the builder's draft check returns the context its main must take", async () => {
    const s = await setup();
    const [build] = await db.owner<{ id: string; fence: string }[]>`
      insert into routine_runs(workspace_id,mode,trigger_kind,status,fence,lease_until)
      values(${s.workspace},'build','build','running',1,clock_timestamp()+interval '1 minute')
      returning id,fence::text`;
    const token = await tokens.issueRoutine(
      s.workspace,
      {
        runId: build?.id as string,
        routineId: null,
        fence: build?.fence as string,
        mode: 'build',
        tools: [],
      },
      new Date(Date.now() + 60000),
    );
    const checked = await s.app.request('/v1/routines/runtime/build/check', {
      key: token,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: 'export async function main() {}\n',
      },
    });
    expect(checked.body).toMatchObject({ problems: [], contextType: 'RoutineContext<"company">' });
    // A draft whose manifest does not parse gets its problems, not a server error.
    for (const manifest of [{}, null, { when: 'record' }]) {
      const broken = await s.app.request('/v1/routines/runtime/build/check', {
        key: token,
        body: { manifest, code: 'export async function main() {}\n' },
      });
      expect(broken.status).toBe(200);
      expect(broken.body.problems.map((p: { code: string }) => p.code)).toContain(
        'invalid_manifest',
      );
      expect(broken.body.contextType).toBeUndefined();
    }
  });

  it('removing a field the code uses pauses the routine before it acts', async () => {
    const s = await setup();
    const { routineId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const removed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [{ op: 'delete_field', object: 'company', field: 'tier' }],
        reason: 'gone',
      },
    });
    expect(removed.status).toBe(200);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme After');
    await s.maintenance.maintain();
    await s.executor.tick();
    const routine = await s.app.request(`/v1/routines/${routineId}`, { key: s.keys.admin });
    expect(routine.body).toMatchObject({ status: 'needs_attention', pausedReason: 'check_failed' });
    const [run] = await db.owner<{ status: string; code: string }[]>`
      select status,code from routine_runs where routine_id=${routineId} and record_id=${acme}`;
    expect(run).toEqual({ status: 'failed', code: 'check_failed' });
  });

  it('replays a recorded effect instead of repeating it, and diverges on another operation', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Test');
    // A test run on one record: claimed, then driven by hand through the runtime API.
    const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    expect(tested.status).toBe(202);
    const runId = tested.body.runId as string;
    const claimed = await s.executor.claim(s.workspace, runId);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId, routineId, fence: claimed.fence, mode: claimed.mode, tools: [] },
      new Date(Date.now() + 60000),
    );
    const effect = (position: number, operation: string, args: Record<string, unknown>) =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: { position, operation, args },
      });
    const update = { object: 'company', id: acme, values: { [tier]: 'silver' } };
    // The same position at once: one write, one replay.
    const [a, b] = await Promise.all([
      effect(1, 'record.update', update),
      effect(1, 'record.update', update),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    const [writes] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='tier'`;
    expect(writes?.n).toBe(1);
    // Different arguments at a recorded position are not repeated; they are flagged.
    const changed = await effect(1, 'record.update', { ...update, values: { [tier]: 'bronze' } });
    expect(changed.body).toMatchObject({ state: 'done', replayed: true, differs: true });
    // Another operation at a recorded position ends the run.
    const diverged = await effect(1, 'remember', { about: acme, text: 'x' });
    expect(diverged.body.error.code).toBe('run_diverged');
    const [run] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${runId}`;
    expect(run?.status).toBe('diverged');
    // A run that ended takes no more effects.
    expect((await effect(2, 'record.update', update)).status).toBeGreaterThanOrEqual(400);
    // The routine token reaches nothing outside the runtime.
    expect((await s.app.request(`/v1/records/${acme}`, { key: token })).status).toBe(403);
  });

  it('two executors claiming one run at once: exactly one gets it', async () => {
    const s = await setup();
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Race');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
        key: s.keys.admin,
        body: { recordId: acme },
      });
      ids.push(tested.body.runId);
    }
    for (const id of ids) {
      const claims = await Promise.all([
        s.executor.claim(s.workspace, id),
        s.executor.claim(s.workspace, id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    }
    const [fences] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from routine_runs where id=any(${ids}::uuid[]) and fence=1 and attempt=1`;
    expect(fences?.n).toBe(5);
  });

  it('a paused routine refuses the next effect of a run already going', async () => {
    const s = await setup();
    const source = {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Tier it' },
        uses: { tools: [], model: false },
      },
      code: TIER_ROUTINE(s.key('tier'), s.key('name')).code,
    };
    const { routineId } = await activate(s, source);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Manual');
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    expect(pressed.status).toBe(202);
    const [queued] = await db.owner<{ id: string }[]>`
      select id from routine_runs where routine_id=${routineId} and status='queued'`;
    const claimed = await s.executor.claim(s.workspace, queued?.id as string);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'run', tools: [] },
      new Date(Date.now() + 60000),
    );
    expect(
      (await s.app.request(`/v1/routines/${routineId}/pause`, { key: s.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    const refused = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'record.update',
        args: { object: 'company', id: acme, values: {} },
      },
    });
    expect(refused.body.error.code).toBe('routine_paused');
  });

  it('forget erases stored results and ends runs in flight as erased', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Forget');
    const doomed = await createCompany(s.app, s.keys.admin, 'Doomed Ltd');
    const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    const claimed = await s.executor.claim(s.workspace, tested.body.runId);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'test', tools: [] },
      new Date(Date.now() + 60000),
    );
    const effect = (position: number) =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: {
          position,
          operation: 'record.update',
          args: { object: 'company', id: acme, values: { [tier]: 'gold' } },
        },
      });
    expect((await effect(1)).body.state).toBe('done');
    // Another run made a call and is waiting to retry; one that made none is left to run.
    const retrying = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    const second = await s.executor.claim(s.workspace, retrying.body.runId);
    if (!second) throw new Error('run not claimed');
    const secondToken = await tokens.issueRoutine(
      s.workspace,
      { runId: second.runId, routineId, fence: second.fence, mode: 'test', tools: [] },
      new Date(Date.now() + 60000),
    );
    const call = await s.app.request('/v1/routines/runtime/effects', {
      key: secondToken,
      body: {
        position: 1,
        operation: 'record.update',
        args: { object: 'company', id: acme, values: { [tier]: 'gold' } },
      },
    });
    expect(call.body.state).toBe('done');
    await db.owner`update routine_runs set status='queued',lease_owner=null,lease_until=null where id=${second.runId}`;
    const untouched = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    const forgot = await s.app.request(`/v1/records/${doomed}/forget`, {
      key: s.keys.admin,
      method: 'POST',
    });
    expect(forgot.status).toBe(200);
    const [stored] = await db.owner<{ result: unknown }[]>`
      select result from routine_run_results where run_id=${claimed.runId}`;
    expect(stored?.result).toBe(null);
    const [run] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${claimed.runId}`;
    expect(run?.status).toBe('erased');
    expect((await effect(2)).body.error.code).toMatch(/run_erased|lease_expired/);
    const statuses = await db.owner<{ id: string; status: string }[]>`
      select id,status from routine_runs where id in (${second.runId},${untouched.body.runId})`;
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [second.runId]: 'erased',
      [untouched.body.runId]: 'queued',
    });
  });

  it('a schedule fires once per matching record per due time, in the workspace time zone', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const zone = await s.app.request('/v1/workspace/time-zone', {
      key: s.keys.admin,
      method: 'PUT',
      body: { timeZone: 'Asia/Jerusalem' },
    });
    expect(zone.status).toBe(200);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Weekly');
    await createCompany(s.app, s.keys.admin, 'Other Weekly');
    const { routineId } = await activate(s, {
      manifest: {
        when: {
          kind: 'schedule',
          cron: '0 9 * * 1',
          object: 'company',
          filter: { [s.key('name')]: { contains: 'Acme' } },
        },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'weekly' });
}
`,
    });
    const [scheduled] = await db.owner<{ next_fire_at: Date }[]>`
      select next_fire_at from routines where id=${routineId}`;
    // Monday 09:00 in Jerusalem is 07:00 or 06:00 UTC.
    expect(scheduled?.next_fire_at.getUTCDay()).toBe(1);
    expect([6, 7]).toContain(scheduled?.next_fire_at.getUTCHours());
    await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${routineId}`;
    await s.maintenance.maintain();
    await s.maintenance.maintain();
    await s.executor.tick();
    const runs = await db.owner<{ record_id: string; status: string; trigger_kind: string }[]>`
      select record_id,status,trigger_kind from routine_runs where routine_id=${routineId}`;
    expect(runs).toEqual([{ record_id: acme, status: 'succeeded', trigger_kind: 'schedule' }]);
    const [next] = await db.owner<{ next_fire_at: Date }[]>`
      select next_fire_at from routines where id=${routineId}`;
    expect(next?.next_fire_at.getTime()).toBeGreaterThan(Date.now());
    // Held runs of a paused routine wait for it to be resumed.
    await s.app.request(`/v1/routines/${routineId}/pause`, { key: s.keys.admin, body: {} });
    const held = await s.app.request(`/v1/routines/${routineId}/held`, {
      key: s.keys.admin,
      body: { action: 'run' },
    });
    expect(held.body.error.code).toBe('routine_not_active');
  });

  it('a preview dry-runs the code on recent matches and writes nothing', async () => {
    const s = await setup();
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Preview');
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBeGreaterThanOrEqual(1);
    await s.executor.tick();
    const preview = await s.app.request(`/v1/routines/previews/${res.body.previewId}`, {
      key: s.keys.agent,
    });
    expect(preview.body.done).toBe(true);
    const run = preview.body.runs.find((r: { recordId: string }) => r.recordId === acme);
    expect(run.status).toBe('succeeded');
    expect(run.calls).toEqual([
      expect.objectContaining({ position: 1, operation: 'record.update', state: 'reported' }),
    ]);
    const record = await s.app.request(`/v1/records/${acme}`, { key: s.keys.admin });
    expect(record.body.fields.tier ?? null).toBe(null);
  });

  it('a preview counts a record merged since its change as the survivor', async () => {
    const s = await setup();
    const survivor = await createCompany(s.app, s.keys.admin, 'Acme Survivor');
    for (let i = 0; i < 5; i++) await createCompany(s.app, s.keys.admin, `Acme ${i}`);
    // The newest match is merged away: its slot goes to the survivor, not to nothing.
    const merged = await createCompany(s.app, s.keys.admin, 'Acme Merged');
    const merge = await s.app.request(`/v1/records/${survivor}/merge`, {
      key: s.keys.admin,
      body: { recordId: merged },
    });
    expect(merge.status).toBe(200);
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    const [first] = await db.owner<{ record_id: string }[]>`
      select record_id from routine_runs where id=${res.body.runs[0]}`;
    expect(first?.record_id).toBe(survivor);
  });

  it('an admin who resumes for an approver who left records a fresh approval', async () => {
    const s = await setup();
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const paused = await s.app.request(`/v1/routines/${routineId}/pause`, {
      key: s.keys.admin,
      body: {},
    });
    expect(paused.status).toBe(200);
    // The original approver is no longer an admin, and approved long ago.
    await db.owner`update routine_versions set approver_user_id='someone-who-left',
      approved_at=now()-interval '10 days' where id=${versionId}`;
    const resumed = await s.app.request(`/v1/routines/${routineId}/resume`, {
      key: s.keys.admin,
      body: {},
    });
    expect(resumed.status).toBe(200);
    const [version] = await db.owner<{ approver_user_id: string; fresh: boolean }[]>`
      select approver_user_id,approved_at>now()-interval '1 minute' as fresh
      from routine_versions where id=${versionId}`;
    expect(version?.approver_user_id).not.toBe('someone-who-left');
    expect(version?.fresh).toBe(true);
  });

  it('a preview samples distinct records, however busy the newest one is', async () => {
    const s = await setup();
    for (const name of ['Acme One', 'Acme Two', 'Acme Three'])
      await createCompany(s.app, s.keys.admin, name);
    const hot = await createCompany(s.app, s.keys.admin, 'Acme Hot');
    // 1,200 newer matching changes, all to one record.
    await db.owner`insert into record_changes(workspace_id,position,record_id,object_type_id,operation,field_keys,cause,cause_depth,created_at)
      select c.workspace_id,c.position+1000000+g,c.record_id,c.object_type_id,'create',c.field_keys,c.cause,c.cause_depth,c.created_at
      from record_changes c, generate_series(1,1200) g where c.record_id=${hot} and c.operation='create'`;
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.body.runs).toHaveLength(4);
    const [first] = await db.owner<{ record_id: string }[]>`
      select record_id from routine_runs where id=${res.body.runs[0]}`;
    expect(first?.record_id).toBe(hot);
  });

  it('a preview type-checks its code in full, even before any validation', async () => {
    const s = await setup();
    await createCompany(s.app, s.keys.admin, 'Acme Unchecked');
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: { ...TIER_ROUTINE(s.key('tier'), s.key('name')), code: 'export const main = 1;\n' },
    });
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBeGreaterThan(0);
    await s.executor.tick();
    const runs = await db.owner<{ status: string; code: string }[]>`
      select status,code from routine_runs where preview_id=${res.body.previewId}`;
    expect(runs.every((r) => r.status === 'failed' && r.code === 'check_failed')).toBe(true);
  });

  it('retention removes a source only validations used, and keeps a version source', async () => {
    const s = await setup();
    const kept = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const validated = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        ...TIER_ROUTINE(s.key('tier'), s.key('name')),
        code: 'export async function main() {\n  return 1;\n}\n',
      },
    });
    await s.executor.tick();
    const [check] = await db.owner<{ source_id: string }[]>`
      select source_id from routine_runs where id=${validated.body.jobId}`;
    // Everything is 31 days old: the runs are past retention, the sources too.
    await db.owner`update routine_runs set finished_at=now()-interval '31 days' where workspace_id=${s.workspace}`;
    await db.owner`update routine_sources set created_at=now()-interval '31 days' where workspace_id=${s.workspace}`;
    await s.maintenance.maintain();
    const sources = await db.owner<{ id: string }[]>`
      select id from routine_sources where workspace_id=${s.workspace}`;
    const [version] = await db.owner<{ source_id: string }[]>`
      select source_id from routine_versions where id=${kept.versionId}`;
    expect(sources.map((row) => row.id)).toEqual([version?.source_id]);
    expect(sources.map((row) => row.id)).not.toContain(check?.source_id);
  });

  it('reserves model calls against the daily cap atomically', async () => {
    const s = await setup({ modelCallsPerDay: 3 });
    const source = {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Ask' },
        uses: { tools: [], model: true },
      },
      code: `export async function main({ retainer }: RoutineContext<'company'>) {
  return retainer.ai.generate({ instructions: 'Say hi', input: null, output: { type: 'string' } });
}
`,
    };
    const { routineId, versionId } = await activate(s, source);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Model');
    const runTokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
        key: s.keys.admin,
        body: { recordId: acme },
      });
      const claimed = await s.executor.claim(s.workspace, tested.body.runId);
      if (!claimed) throw new Error('run not claimed');
      runTokens.push(
        await tokens.issueRoutine(
          s.workspace,
          { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'test', tools: [] },
          new Date(Date.now() + 60000),
        ),
      );
    }
    const answers = await Promise.all(
      runTokens.map((key) =>
        s.app.request('/v1/routines/runtime/effects', {
          key,
          body: {
            position: 1,
            operation: 'ai.generate',
            args: { instructions: 'Say hi', input: null, output: { type: 'string' } },
          },
        }),
      ),
    );
    const states = answers.map((a) => a.body.state ?? a.body.error?.code).sort();
    expect(states).toEqual([
      'budget_exhausted',
      'budget_exhausted',
      'budget_exhausted',
      'model',
      'model',
      'model',
    ]);
    const [day] = await db.owner<{ count: number }[]>`
      select count from routine_model_days where workspace_id=${s.workspace}`;
    expect(day?.count).toBe(3);
  });
  it('a refused call keeps its position, so code that catches it goes on', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Refused');
    const { runId, effect } = await drive(s, routineId, versionId, acme);
    const missing = { object: 'company', id: randomUUID(), values: { [tier]: 'gold' } };
    const refused = await effect(1, 'record.update', missing);
    expect(refused.status).toBe(404);
    const next = await effect(2, 'record.update', {
      object: 'company',
      id: acme,
      values: { [tier]: 'gold' },
    });
    expect(next.body).toMatchObject({ state: 'done', replayed: false });
    const rows = await db.owner<{ position: number; state: string; code: string | null }[]>`
      select position,state,code from routine_run_results where run_id=${runId} order by position`;
    expect(rows).toEqual([
      { position: 1, state: 'failed', code: 'not_found' },
      { position: 2, state: 'done', code: null },
    ]);
    // A retry gets the same refusal at that position.
    expect((await effect(1, 'record.update', missing)).body.error.code).toBe('not_found');
    const [run] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${runId}`;
    expect(run?.status).toBe('running');
  });

  it('caps each read operation per run, atomically under concurrent reads', async () => {
    const s = await setup();
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Reads');
    const { token } = await drive(s, routineId, versionId, acme);
    const read = () =>
      s.app.request('/v1/routines/runtime/read', {
        key: token,
        body: { operation: 'record.get', args: { object: 'company', id: acme } },
      });
    const results = await Promise.all(Array.from({ length: 210 }, read));
    const codes = results.map((r) => (r.status === 200 ? 'ok' : r.body.error.code));
    expect(codes.filter((c) => c === 'ok')).toHaveLength(200);
    expect(codes.filter((c) => c === 'operation_limit')).toHaveLength(10);
    // Aggregates name fields by key, as the code does.
    const tier = s.key('tier');
    const aggregate = await s.app.request('/v1/routines/runtime/read', {
      key: token,
      body: {
        operation: 'record.aggregate',
        args: { object: 'company', aggregates: [{ field: tier, op: 'countEmpty' }] },
      },
    });
    expect(aggregate.body.result.values).toEqual([
      expect.objectContaining({ field: tier, op: 'countEmpty' }),
    ]);
    // Another operation has its own count.
    const query = await s.app.request('/v1/routines/runtime/read', {
      key: token,
      body: { operation: 'record.query', args: { object: 'company' } },
    });
    expect(query.status).toBe(200);
  });

  it('approving after the workspace changed queues one committed recheck', async () => {
    const s = await setup();
    const source = TIER_ROUTINE(s.key('tier'), s.key('name'));
    const validated = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: source,
    });
    await s.executor.tick();
    expect(
      (await s.app.request(`/v1/routines/jobs/${validated.body.jobId}`, { key: s.keys.agent })).body
        .valid,
    ).toBe(true);
    const proposed = await s.app.request('/v1/routines', {
      key: s.keys.agent,
      body: {
        ...source,
        name: 'Tier',
        description: 'Tier Acme.',
        summary: 'Tiers Acme.',
        report: { verdict: 'full', gaps: [] },
      },
    });
    const { routineId, versionId } = proposed.body;
    // A new field changes the types the code is checked against.
    const changed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: { name: 'size', label: 'Size', type: 'text' },
          },
        ],
        reason: 'Recheck test',
      },
    });
    expect(changed.status).toBe(200);
    const approve = () =>
      s.app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
        key: s.keys.admin,
        body: {},
      });
    const first = await approve();
    expect(first.body.error.code).toBe('check_required');
    const jobId = first.body.error.details.jobId;
    expect((await s.app.request(`/v1/routines/jobs/${jobId}`, { key: s.keys.admin })).status).toBe(
      200,
    );
    // Asking again while it runs reuses the same check.
    expect((await approve()).body.error.details.jobId).toBe(jobId);
    await s.executor.tick();
    expect((await approve()).status).toBe(200);
  });

  it('a daily cap of 0 allows no model call', async () => {
    const s = await setup({ modelCallsPerDay: 0 });
    const { routineId, versionId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Ask' },
        uses: { tools: [], model: true },
      },
      code: `export async function main({ retainer }: RoutineContext<'company'>) {
  return retainer.ai.generate({ instructions: 'Say hi', input: null, output: { type: 'string' } });
}
`,
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Zero');
    const { effect } = await drive(s, routineId, versionId, acme);
    const asked = await effect(1, 'ai.generate', {
      instructions: 'Say hi',
      input: null,
      output: { type: 'string' },
    });
    expect(asked.body.error.code).toBe('budget_exhausted');
    const days = await db.owner`select 1 from routine_model_days where workspace_id=${s.workspace}`;
    expect(days).toHaveLength(0);
  });

  it('a schedule tick matching more than can be held holds none and pauses', async () => {
    const s = await setup();
    const limits = ROUTINE_LIMITS as { scheduleFanOut: number; scheduleHeldMax: number };
    const saved = { ...limits };
    limits.scheduleFanOut = 1;
    limits.scheduleHeldMax = 2;
    try {
      for (const name of ['Acme A', 'Acme B', 'Acme C'])
        await createCompany(s.app, s.keys.admin, name);
      const { routineId } = await activate(s, {
        manifest: {
          when: { kind: 'schedule', cron: '0 9 * * 1', object: 'company' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
      });
      await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${routineId}`;
      await s.maintenance.maintain();
      const runs =
        await db.owner`select 1 from routine_runs where routine_id=${routineId} and mode='run'`;
      expect(runs).toHaveLength(0);
      const [routine] = await db.owner<{ status: string; paused_reason: string }[]>`
        select status,paused_reason from routines where id=${routineId}`;
      expect(routine).toEqual({ status: 'needs_attention', paused_reason: 'schedule_too_large' });
    } finally {
      Object.assign(limits, saved);
    }
  });

  it('the hourly cap counts scheduled runs: past it the tick holds them and pauses', async () => {
    const s = await setup();
    const limits = ROUTINE_LIMITS as { runsPerHour: number };
    const saved = limits.runsPerHour;
    limits.runsPerHour = 2;
    try {
      for (const name of ['Acme A', 'Acme B', 'Acme C'])
        await createCompany(s.app, s.keys.admin, name);
      const { routineId } = await activate(s, {
        manifest: {
          when: { kind: 'schedule', cron: '0 9 * * 1', object: 'company' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
      });
      await db.owner`update routines set next_fire_at=now()-interval '1 minute' where id=${routineId}`;
      await s.maintenance.maintain();
      const runs = await db.owner<{ status: string }[]>`
        select status from routine_runs where routine_id=${routineId} and mode='run'`;
      // The third run is over the cap; the pause holds the tick's others too.
      expect(runs.map((r) => r.status)).toEqual(['held', 'held', 'held']);
      const [routine] = await db.owner<{ status: string; paused_reason: string }[]>`
        select status,paused_reason from routines where id=${routineId}`;
      expect(routine).toEqual({ status: 'needs_attention', paused_reason: 'runs_held' });
    } finally {
      limits.runsPerHour = saved;
    }
  });

  it('clears a run output after 7 days even when the run made no calls', async () => {
    const s = await setup();
    const [run] = await db.owner<{ id: string }[]>`
      insert into routine_runs(workspace_id,mode,trigger_kind,status,output,finished_at)
      values(${s.workspace},'check','check','succeeded','{"copied":"crm data"}'::jsonb,now()-interval '8 days')
      returning id`;
    await s.maintenance.maintain();
    const [after] = await db.owner<{ output: unknown }[]>`
      select output from routine_runs where id=${run?.id as string}`;
    expect(after?.output).toBe(null);
  });
  it('a routine paused mid-burst holds the rest of the burst, past one page', async () => {
    const s = await setup();
    const limits = ROUTINE_LIMITS as { runsPerHour: number };
    const saved = limits.runsPerHour;
    limits.runsPerHour = 1;
    try {
      const { routineId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
      for (let i = 0; i < 5; i++) await createCompany(s.app, s.keys.admin, `Acme Burst ${i}`);
      // Two changes a page: the routine pauses on the first page and must go on.
      await dispatchRoutines(s.app.sql, s.workspace, 2);
      // Every record of the burst has a run; pausing holds the one it queued too.
      const runs = await db.owner<{ status: string }[]>`
        select status from routine_runs where routine_id=${routineId} and mode='run'`;
      expect(runs.map((r) => r.status)).toEqual(['held', 'held', 'held', 'held', 'held']);
    } finally {
      limits.runsPerHour = saved;
    }
  });

  it('a merge triggers nothing, and the merged-away record’s queued run moves or folds', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'record', object: 'company', on: ['updated'], fields: [s.key('name')] },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
    });
    // A second routine watches a person's company: the merge repoints it, and that is no trigger either.
    const person = s.caps.objects.find((o: { name: string }) => o.name === 'person');
    const companyKey = person.fields.find((f: { name: string }) => f.name === 'company').key;
    const { routineId: personRoutine } = await activate(s, {
      manifest: {
        when: { kind: 'record', object: 'person', on: ['updated'], fields: [companyKey] },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'person'>) {
  return record.id;
}
`,
    });
    const survivor = await createCompany(s.app, s.keys.admin, 'Acme Survivor');
    const merged = await createCompany(s.app, s.keys.admin, 'Acme Merged');
    const employee = await s.app.request('/v1/objects/person/records', {
      key: s.keys.admin,
      body: { values: { name: 'Ada Employee', company: merged } },
    });
    expect(employee.status).toBe(201);
    const lone = await createCompany(s.app, s.keys.admin, 'Lone Survivor');
    const other = await createCompany(s.app, s.keys.admin, 'Lone Merged');
    const rename = (id: string, name: string) =>
      s.app.request(`/v1/records/${id}`, {
        key: s.keys.admin,
        method: 'PATCH',
        body: { values: { name } },
      });
    for (const [id, name] of [
      [survivor, 'Acme Survivor 2'],
      [merged, 'Acme Merged 2'],
      [other, 'Lone Merged 2'],
    ] as const)
      expect((await rename(id, name)).status).toBe(200);
    await s.maintenance.maintain();
    const merge = (into: string, from: string) =>
      s.app.request(`/v1/records/${into}/merge`, {
        key: s.keys.admin,
        body: { recordId: from, values: { name: 'Merged name' } },
      });
    expect((await merge(survivor, merged)).status).toBe(200);
    expect((await merge(lone, other)).status).toBe(200);
    await s.maintenance.maintain();
    const runs = await db.owner<{ record_id: string; status: string; code: string | null }[]>`
      select record_id,status,code from routine_runs where routine_id=${routineId} and mode='run'
      order by created_at`;
    // Created in one transaction, so in no particular order.
    expect(runs).toHaveLength(3);
    expect(runs).toEqual(
      expect.arrayContaining([
        { record_id: survivor, status: 'queued', code: null },
        { record_id: merged, status: 'discarded', code: 'merged' },
        { record_id: lone, status: 'queued', code: null },
      ]),
    );
    const personRuns =
      await db.owner`select 1 from routine_runs where routine_id=${personRoutine} and mode='run'`;
    expect(personRuns).toHaveLength(0);
    const [repointed] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from record_changes where record_id=${employee.body.id} and merged_from_id=${merged}`;
    expect(repointed?.n).toBe(1);
  });

  it('a run on a merged-away record and one on its survivor never run at once', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Go' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
    });
    const survivor = await createCompany(s.app, s.keys.admin, 'Acme A');
    const merged = await createCompany(s.app, s.keys.admin, 'Acme B');
    const press = async (id: string) =>
      (
        await s.app.request(`/v1/routines/${routineId}/run`, {
          key: s.keys.admin,
          body: { recordIds: [id] },
        })
      ).body.runs[0] as string;
    // X runs on B; B is merged into A while X is running, so X moves to A.
    const x = await press(merged);
    expect(await s.executor.claim(s.workspace, x)).not.toBe(null);
    expect(
      (
        await s.app.request(`/v1/records/${survivor}/merge`, {
          key: s.keys.admin,
          body: { recordId: merged },
        })
      ).status,
    ).toBe(200);
    const [moved] = await db.owner<
      { record_id: string }[]
    >`select record_id from routine_runs where id=${x}`;
    expect(moved?.record_id).toBe(survivor);
    // While X runs, a run on A waits.
    const y = await press(survivor);
    expect(await s.executor.claim(s.workspace, y)).toBe(null);
    // X goes back to wait for a retry; Y starts; X's retry now waits for Y.
    await db.owner`update routine_runs set status='queued',lease_owner=null,lease_until=null where id=${x}`;
    expect(await s.executor.claim(s.workspace, y)).not.toBe(null);
    expect(await s.executor.claim(s.workspace, x)).toBe(null);
  });
  it('runs on both sides of a merge claimed at once: exactly one starts', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Go' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'company'>) {
  return record.id;
}
`,
    });
    const press = async (id: string) =>
      (
        await s.app.request(`/v1/routines/${routineId}/run`, {
          key: s.keys.admin,
          body: { recordIds: [id] },
        })
      ).body.runs[0] as string;
    for (let i = 0; i < 5; i++) {
      const survivor = await createCompany(s.app, s.keys.admin, `Race A ${i}`);
      const merged = await createCompany(s.app, s.keys.admin, `Race B ${i}`);
      // X runs on B and W on A when B is merged into A: both started before
      // the merge, so X keeps B until it ends.
      const x = await press(merged);
      const w = await press(survivor);
      expect(await s.executor.claim(s.workspace, x)).not.toBe(null);
      expect(await s.executor.claim(s.workspace, w)).not.toBe(null);
      const merge = await s.app.request(`/v1/records/${survivor}/merge`, {
        key: s.keys.admin,
        body: { recordId: merged },
      });
      expect(merge.status).toBe(200);
      const [kept] = await db.owner<
        { record_id: string }[]
      >`select record_id from routine_runs where id=${x}`;
      expect(kept?.record_id).toBe(merged);
      // X waits for a retry on B; W ends; Y is queued on A. X and Y are claimed at once.
      await db.owner`update routine_runs set status='queued',lease_owner=null,lease_until=null where id=${x}`;
      await db.owner`update routine_runs set status='succeeded',finished_at=clock_timestamp(),
        lease_owner=null,lease_until=null where id=${w}`;
      const y = await press(survivor);
      const claims = await Promise.all([
        s.executor.claim(s.workspace, x),
        s.executor.claim(s.workspace, y),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const running = await db.owner<{ record_id: string }[]>`
        select record_id from routine_runs where id=any(${[x, y]}::uuid[]) and status='running'`;
      expect(running).toEqual([{ record_id: survivor }]);
    }
  });

  it('a routine runs on an older message of a Gmail thread, which lists leave out', async () => {
    const s = await setup();
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'conversation', label: 'Go' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ record }: RoutineContext<'conversation'>) {
  return { seen: record.id };
}
`,
    });
    const log = async (title: string, occurredAt: string) => {
      const event = await s.app.request('/v1/events', {
        key: s.keys.admin,
        body: { type: 'conversation', channel: 'gmail', occurredAt, title },
      });
      expect(event.status).toBe(201);
      return event.body.id as string;
    };
    const first = await log('First message', '2026-11-10T10:00:00Z');
    const reply = await log('Reply', '2026-11-10T11:00:00Z');
    // Both messages are in one Gmail thread; activity shows only the newest.
    const thread = randomUUID();
    for (const [id, at] of [
      [first, '2026-11-10T10:00:00Z'],
      [reply, '2026-11-10T11:00:00Z'],
    ] as const)
      await db.owner`insert into gmail_messages(event_id,workspace_id,thread_group_id,occurred_at,body)
        values(${id},${s.workspace},${thread},${at},'')`;
    const listed = await s.app.request('/v1/objects/conversation/query', {
      key: s.keys.admin,
      body: {},
    });
    expect(listed.status).toBe(200);
    expect(listed.body.records.map((r: { id: string }) => r.id)).not.toContain(first);
    const ran = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [first] },
    });
    const run = ran.body.runs[0] as string;
    const claimed = await s.executor.claim(s.workspace, run);
    expect(claimed).not.toBe(null);
    await s.executor.execute(claimed as NonNullable<typeof claimed>);
    const [row] = await db.owner<{ status: string; code: string | null }[]>`
      select status,code from routine_runs where id=${run}`;
    expect(row).toEqual({ status: 'succeeded', code: null });
  });
});
