import { randomUUID } from 'node:crypto';
import type { Invocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { executeWebhookFixture, WEBHOOK_SETUP_ID, WEBHOOK_SYNC_ID } from './webhook-fixture.js';

const id = randomUUID(),
  itemId = randomUUID();
const invocation = (functionId: string, input: unknown): Invocation => ({
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: id,
  releaseDigest: 'a'.repeat(64),
  functionId,
  input: input as Invocation['input'],
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_fixture',
  deadline: new Date(Date.now() + 120000).toISOString(),
});
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
describe('reviewed webhook source fixture', () => {
  it('attests setup and writes generated signing material without disclosing it through ordinary settings or KV', async () => {
    const calls: { path: string; method: string; input: unknown }[] = [],
      secret = `whsec_${Buffer.alloc(32).toString('base64')}`;
    const transport: typeof fetch = async (url, options) => {
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer rt_run_fixture');
      const path = new URL(String(url)).pathname,
        method = options?.method ?? 'GET';
      calls.push({ path, method, input: options?.body ? JSON.parse(String(options.body)) : null });
      if (path.endsWith('/secrets/fixtureKey')) return reply({ value: secret, revision: 1 });
      if (path.endsWith('/secrets/signing') && method === 'GET')
        return reply({ error: { code: 'connection_required', message: 'missing' } }, 409);
      return reply({
        revision: 1,
        sourceAccountId: randomUUID(),
        bindingId: 'fixture-binding',
        url: 'https://retainer.test/extensions/hooks/fixture/notes',
      });
    };
    expect(
      await executeWebhookFixture(
        invocation(WEBHOOK_SETUP_ID, {}),
        new AbortController().signal,
        transport,
      ),
    ).toEqual({ status: 'succeeded' });
    expect(calls.findIndex((call) => call.path.endsWith('/webhooks/prepare'))).toBeLessThan(
      calls.findIndex((call) => call.path.endsWith('/source/verify')),
    );
    expect(calls.find((call) => call.path.endsWith('/source/verify'))?.input).toEqual({
      accountId: 'compose-fixture-account',
      sharing: 'workspace',
    });
    expect(calls.find((call) => call.method === 'PUT')?.input).toEqual({
      expectedRevision: null,
      value: secret,
    });
    expect(calls.find((call) => call.path.endsWith('/runtime/webhooks'))?.input).toEqual({
      route: 'notes',
      subscriptionId: 'compose-fixture-subscription',
    });
    expect(calls.some((call) => call.path.includes('/kv/') || call.path.includes('/records'))).toBe(
      false,
    );
  });
  it('syncs only its leased source ID through the scoped SDK and refuses external URLs as fixture source identities', async () => {
    const calls: { path: string; input: unknown }[] = [];
    let externalId = 'compose-note-1';
    const transport: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, input: options?.body ? JSON.parse(String(options.body)) : null });
      return reply(
        path.includes('/source-items/') && !path.endsWith('/prepare')
          ? { sourceItemId: itemId, externalId, revisionId: null }
          : { created: true },
      );
    };
    expect(
      await executeWebhookFixture(
        invocation(WEBHOOK_SYNC_ID, { sourceItemId: itemId }),
        new AbortController().signal,
        transport,
      ),
    ).toEqual({ status: 'succeeded' });
    const body = calls.find((call) => call.path.endsWith('/source-events'))?.input;
    expect(body).toMatchObject({
      sourceItemId: itemId,
      providerRevision: '1',
      expectedRevisionId: null,
      event: { title: 'Compose webhook note' },
    });
    expect(body).not.toHaveProperty('actor');
    calls.length = 0;
    externalId = 'http://169.254.169.254/';
    expect(
      await executeWebhookFixture(
        invocation(WEBHOOK_SYNC_ID, { sourceItemId: itemId }),
        new AbortController().signal,
        transport,
      ),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
    expect(calls).toHaveLength(1);
    calls.length = 0;
    expect(
      await executeWebhookFixture(
        invocation(WEBHOOK_SYNC_ID, { externalId: 'caller-body' }),
        new AbortController().signal,
        transport,
      ),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});
