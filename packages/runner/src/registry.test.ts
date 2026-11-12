import type { Invocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { execute, FIXTURE_FUNCTION_ID } from './registry.js';

const invocation: Invocation = {
  protocolVersion: 1,
  runId: '8b6c5882-7c8d-4d99-85e9-53d7bf06aa21',
  attempt: 1,
  installationId: '61816969-3b72-48be-bbde-be8cfa32c4cd',
  releaseDigest: 'a'.repeat(64),
  functionId: FIXTURE_FUNCTION_ID,
  input: { sourceId: 'source-1', name: 'Fixture company' },
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_fixture_only',
  deadline: '2026-11-11T20:00:00.000Z',
};
describe('release-bundled deterministic fixture', () => {
  it('writes only through the scoped SDK and reuses the business idempotency key', async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    const transport: typeof fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ id: 'created' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const signal = new AbortController().signal;
    expect(await execute(invocation, signal, transport)).toEqual({ status: 'succeeded' });
    expect(await execute({ ...invocation, attempt: 2 }, signal, transport)).toEqual({
      status: 'succeeded',
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('https://retainer.test/v1/objects/company/records');
      expect(new Headers(call.options?.headers).get('authorization')).toBe(
        'Bearer rt_run_fixture_only',
      );
      expect(new Headers(call.options?.headers).get('idempotency-key')).toBe('fixture:source-1');
      expect(call.options?.signal).toBe(signal);
      expect(JSON.parse(String(call.options?.body))).toEqual({
        values: { name: 'Fixture company' },
      });
    }
  });
  it('refuses unbundled functions and unexpected input before network access', async () => {
    const forbidden: typeof fetch = async () => {
      throw new Error('network must not be used');
    };
    const signal = new AbortController().signal;
    expect(
      await execute({ ...invocation, functionId: invocation.runId }, signal, forbidden),
    ).toEqual({ status: 'failed', code: 'function_not_bundled' });
    expect(
      await execute(
        {
          ...invocation,
          input: { ...(invocation.input as object), moduleUrl: 'https://attacker.test/module.js' },
        },
        signal,
        forbidden,
      ),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
  });
});
