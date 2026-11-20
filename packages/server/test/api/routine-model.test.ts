import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunTokens } from '../../src/extension-runtime/tokens.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { fakeAnthropic, testRunTokens, type Upstream } from '../helpers/model.js';

// Routine model calls (routines spec §4.5, §6.3) through the self-hosted
// proxy, against real Postgres, with Anthropic faked at the HTTP boundary.
const db = useTestDatabase();
const PROXY = 'http://retainer.test/v1/extensions/runtime/model';
let t: TestApp, upstream: Upstream, tokens: RunTokens, workspace: string, runId: string;

beforeAll(async () => {
  upstream = await fakeAnthropic();
  ({ tokens } = await testRunTokens());
  t = startTestApp(db, {
    runTokens: tokens,
    model: { apiKey: 'sk-ant-retainer-secret-key', upstream: upstream.origin },
  });
  const setup = await t.setupWorkspace(
    { name: `Routine model ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  workspace = setup.workspace.id;
  const [run] = await db.owner<{ id: string }[]>`
    insert into routine_runs(workspace_id,mode,trigger_kind,status) values(${workspace},'build','build','running')
    returning id`;
  runId = run?.id as string;
});
afterAll(() => db.owner`delete from workspaces where id=${workspace}`);

const token = (maxTokens = 4096) =>
  tokens.issueRoutineModel(
    {
      kind: 'routine',
      workspaceId: workspace,
      routineId: null,
      runId,
      position: 1,
      attempt: 1,
      model: 'claude-opus-5-5',
      maxTokens,
    },
    new Date(Date.now() + 60000),
  );
const call = async (body: Record<string, unknown>, path = '/v1/messages', key?: string) =>
  t.app.request(`${PROXY}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': key ?? (await token()),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
const plain = {
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  system: 'Answer.',
  messages: [{ role: 'user', content: 'hi' }],
  output_config: { format: { type: 'json_schema', schema: { type: 'string' } } },
};

describe('routine model tokens', () => {
  it('forwards one plain call and records usage against the run, never content', async () => {
    const before = upstream.received.length;
    const response = await call(plain);
    expect(response.status).toBe(200);
    expect(upstream.received.length).toBe(before + 1);
    const forwarded = upstream.received.at(-1);
    expect(forwarded?.headers['x-api-key']).toBe('sk-ant-retainer-secret-key');
    await response.text();
    await vi.waitFor(async () => {
      const rows = await db.owner<{ kind: string; routine_run_id: string; input_tokens: number }[]>`
        select kind,routine_run_id,input_tokens::int from ai_usage where workspace_id=${workspace}`;
      expect(rows).toEqual([{ kind: 'routine', routine_run_id: runId, input_tokens: 12 }]);
    });
  });

  it('refuses tools, other models, larger outputs and other endpoints', async () => {
    const refused = async (response: Response | Promise<Response>) => {
      const r = await response;
      expect(r.status).toBeGreaterThanOrEqual(400);
      return ((await r.json()) as { error: { message: string } }).error.message;
    };
    expect(
      await refused(call({ ...plain, tools: [{ name: 'x', input_schema: { type: 'object' } }] })),
    ).toContain('tools');
    expect(await refused(call({ ...plain, model: 'claude-haiku-5-5' }))).toContain(
      'claude-opus-5-5',
    );
    expect(await refused(call({ ...plain, max_tokens: 5000 }))).toContain('max_tokens');
    expect(
      await refused(call({ ...plain, max_tokens: 900 }, '/v1/messages', await token(800))),
    ).toContain('max_tokens');
    expect(await refused(call(plain, '/v1/messages/count_tokens'))).toContain('routine');
  });
});
