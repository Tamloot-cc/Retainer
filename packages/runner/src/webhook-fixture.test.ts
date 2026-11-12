import { randomUUID } from 'node:crypto';
import type { Invocation } from '@retainer/extension';
import { BASE_EVENT_FIELD_IDS } from '@retainer/shared';
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
  it('stages ownership and finalizes bytes before importing through a stable field UUID, without sending the run bearer to storage', async () => {
    const fileId = randomUUID(),
      calls: { path: string; method: string; body: any }[] = [];
    const transport: typeof fetch = async (url, options) => {
      const address = new URL(String(url)),
        path = address.pathname,
        method = options?.method ?? 'GET';
      if (address.hostname === 'bytes.test') {
        expect(new Headers(options?.headers).has('authorization')).toBe(false);
        calls.push({ path, method, body: String(options?.body) });
        return new Response(null, { status: 201 });
      }
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      calls.push({ path, method, body });
      if (path.endsWith('/schema'))
        return reply({
          objects: [
            {
              fields: [{ baseField: 'conversationTranscript', type: 'files' }],
            },
          ],
        });
      if (path.endsWith(`/extensions/${id}`))
        return reply({ settings: { includeTranscript: true } });
      if (path.endsWith('/files/intents'))
        return reply({
          id: fileId,
          upload: {
            url: 'https://bytes.test/upload',
            headers: { 'content-type': 'text/plain' },
            expiresAt: '2099-01-01T00:00:00Z',
          },
        });
      if (path.includes('/source-items/') && !path.endsWith('/prepare'))
        return reply({ sourceItemId: itemId, externalId: 'compose-note-1', revisionId: null });
      return reply({ created: true });
    };
    expect(
      await executeWebhookFixture(
        invocation(WEBHOOK_SYNC_ID, { sourceItemId: itemId }),
        new AbortController().signal,
        transport,
      ),
    ).toEqual({ status: 'succeeded' });
    const prepare = calls.findIndex((call) => call.path.endsWith('/prepare')),
      upload = calls.findIndex((call) => call.path === '/upload'),
      finalize = calls.findIndex((call) => call.path.endsWith('/finalize')),
      sync = calls.findIndex((call) => call.path.endsWith('/source-events'));
    expect(prepare).toBeLessThan(upload);
    expect(upload).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(sync);
    expect(calls[sync]?.body.event.fields).toEqual({
      [BASE_EVENT_FIELD_IDS.conversationTranscript]: [fileId],
    });
  });

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
