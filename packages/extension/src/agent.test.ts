import { describe, expect, it } from 'vitest';
import { agentClient, waitFor, withAgentResult } from './agent.js';
import { agentUseNotice, functionSchema } from './index.js';
import { executionResultSchema } from './protocol.js';

const fn = {
  universalId: crypto.randomUUID(),
  name: 'enrich',
  description: 'Asks the agent',
  handlerDigest: 'b'.repeat(64),
  trigger: { kind: 'job' },
  inputSchema: { type: 'object', additionalProperties: false },
};

describe('agent use in a release', () => {
  it('needs uses: agent and agent.tools together, and no tool hands tasks to it', () => {
    expect(
      functionSchema.safeParse({ ...fn, uses: ['agent'], agent: { tools: ['retainer.read'] } })
        .success,
    ).toBe(true);
    expect(functionSchema.safeParse({ ...fn, uses: ['agent'] }).success).toBe(false);
    expect(functionSchema.safeParse({ ...fn, agent: { tools: ['retainer.read'] } }).success).toBe(
      false,
    );
  });

  it('says what the agent can do, and that data goes to Anthropic', () => {
    const notice = agentUseNotice(['retainer.read', 'web.search']);
    expect(notice).toContain('read this workspace and search the web');
    expect(notice).toContain('Anthropic');
  });
});

describe('waiting for a task', () => {
  it('parks with { wait } only on success without output', () => {
    const id = crypto.randomUUID();
    expect(executionResultSchema.safeParse(waitFor(id)).success).toBe(true);
    expect(executionResultSchema.safeParse({ status: 'failed', wait: id }).success).toBe(false);
    expect(
      executionResultSchema.safeParse({ status: 'succeeded', wait: id, output: 1 }).success,
    ).toBe(false);
  });

  it('stages through the runtime route with the run token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const taskId = crypto.randomUUID();
    const client = agentClient(
      { apiOrigin: 'https://retainer.test', runToken: 'rt_run_x', installationId: 'inst' },
      (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ taskId }), { status: 201 });
      }) as typeof fetch,
    );
    const started = await client.start({
      instructions: 'Find it.',
      tools: ['retainer.read'],
      output: { type: 'string' },
    });
    expect(started).toEqual({ taskId });
    expect(calls[0]?.url).toBe('https://retainer.test/v1/extensions/inst/runtime/agent-tasks');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer rt_run_x',
    );
  });

  it('routes an answer to onAgentResult', async () => {
    const invocation = {
      agentResult: { taskId: crypto.randomUUID(), status: 'completed', answer: 'x' },
    } as never;
    const result = await withAgentResult(invocation, {
      run: async () => ({ status: 'failed' }),
      onAgentResult: async (r) => ({ status: 'succeeded', output: r.status }),
    });
    expect(result).toEqual({ status: 'succeeded', output: 'completed' });
  });
});
