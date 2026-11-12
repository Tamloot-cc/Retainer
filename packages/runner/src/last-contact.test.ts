import { randomUUID } from 'node:crypto';
import { defineExtension, type Invocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { executeLastContact, LAST_CONTACT, lastContactManifest } from './last-contact.js';

const invocation = (functionId: string, input: unknown = {}): Invocation => ({
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: randomUUID(),
  releaseDigest: 'a'.repeat(64),
  functionId,
  input: input as Invocation['input'],
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_last_contact',
  deadline: new Date(Date.now() + 120000).toISOString(),
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signal = () => new AbortController().signal;
const build = {
  packageDigest: 'a'.repeat(64),
  handlerDigest: 'b'.repeat(64),
  serverRange: '>=0.1.0 <0.2.0',
};
describe('last-contact adapter', () => {
  it('pins only contributed nullable date fields and runtime functions', () => {
    const manifest = lastContactManifest(build);
    expect(manifest.functions).toHaveLength(6);
    expect(manifest.lastContact?.fields).toHaveLength(2);
    expect(() =>
      defineExtension({
        ...manifest,
        lastContact: { ...manifest.lastContact, functionIds: [LAST_CONTACT.setup] },
      }),
    ).toThrow('last-contact');
    expect(() =>
      defineExtension({
        ...manifest,
        lastContact: {
          ...manifest.lastContact,
          fields: [{ objectId: randomUUID(), fieldId: randomUUID() }],
        },
      }),
    ).toThrow('last-contact');
    expect(() =>
      defineExtension({
        ...manifest,
        schema: manifest.schema.map((entry) => ({
          ...entry,
          definition: { ...entry.definition, isUnique: true },
        })),
      }),
    ).toThrow('last-contact');
    expect(() => defineExtension({ ...manifest, scopes: ['read'] })).toThrow('last-contact');
  });
  it('starts an operational scan atomically from setup and makes a retry of that setup quiet', async () => {
    const run = invocation(LAST_CONTACT.setup),
      calls: { path: string; body: any }[] = [];
    let stored: any = null;
    const transport: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path.includes('/runtime/kv/')) return response(stored);
      expect(path.endsWith('/runtime/checkpoint')).toBe(true);
      stored = { revision: 1, value: body.kv.value };
      return response({});
    };
    expect(await executeLastContact(run, signal(), transport)).toEqual({ status: 'succeeded' });
    const checkpoint = calls.find((call) => call.path.endsWith('/checkpoint'))?.body;
    expect(checkpoint.children).toEqual([
      { functionId: LAST_CONTACT.scan, input: {}, dedupeKey: `scan-kick:${run.runId}` },
    ]);
    expect(checkpoint.kv.value).toMatchObject({
      after: null,
      through: null,
      done: false,
      startedBy: run.runId,
    });
    const count = calls.length;
    await executeLastContact({ ...run, attempt: 2 }, signal(), transport);
    expect(calls.slice(count).every((call) => call.path.includes('/runtime/kv/'))).toBe(true);
  });
  it('accepts the trusted scheduled timestamp while refusing malformed or setup payloads', async () => {
    const run = invocation(LAST_CONTACT.schedule, { scheduledAt: new Date().toISOString() });
    let calls = 0;
    const transport: typeof fetch = async (url) => {
      calls++;
      return response(new URL(String(url)).pathname.includes('/runtime/kv/') ? null : {});
    };
    expect(await executeLastContact(run, signal(), transport)).toEqual({ status: 'succeeded' });
    expect(calls).toBe(2);
    for (const input of [
      {},
      { scheduledAt: 'bad' },
      { scheduledAt: new Date().toISOString(), after: randomUUID() },
    ])
      expect(await executeLastContact({ ...run, input }, signal(), transport)).toEqual({
        status: 'failed',
        code: 'invalid_input',
      });
    expect(
      await executeLastContact({ ...run, functionId: LAST_CONTACT.setup }, signal(), transport),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
    expect(calls).toBe(2);
  });
  it('keeps record cursors in erasable KV, fixes the scan upper bound and queues empty child input with a fresh root after privacy clears KV', async () => {
    const run = invocation(LAST_CONTACT.scan),
      after = randomUUID(),
      through = randomUUID(),
      checkpoints: any[] = [];
    let stored: any = null,
      first = true;
    const transport: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.includes('/runtime/kv/')) return response(stored);
      if (path.endsWith('/runtime/last-contact')) {
        expect(body).toEqual(
          first ? { kind: 'scan', after: null } : { kind: 'scan', after, through },
        );
        return response({ processed: 20, changed: 2, nextAfter: after, through });
      }
      expect(path.endsWith('/runtime/checkpoint')).toBe(true);
      checkpoints.push(body);
      stored = { revision: (stored?.revision ?? 0) + 1, value: body.kv.value };
      return response({});
    };
    await executeLastContact(run, signal(), transport);
    first = false;
    await executeLastContact({ ...run, runId: randomUUID() }, signal(), transport);
    expect(checkpoints[0].children[0].input).toEqual({});
    expect(JSON.stringify(checkpoints[0].children)).not.toContain(after);
    expect(checkpoints[0].kv.value).toMatchObject({ after, through, done: false });
    stored = null;
    first = true;
    await executeLastContact({ ...run, attempt: 2 }, signal(), transport);
    expect(checkpoints[2].kv.value.root).not.toBe(checkpoints[0].kv.value.root);
    expect(checkpoints[2].children[0].dedupeKey).not.toBe(checkpoints[0].children[0].dedupeKey);
  });
  it('processes minimal change identities in bounded batches and recovers excessive fanout with a paged scan', async () => {
    const recordIds = Array.from({ length: 25 }, () => randomUUID()),
      calls: any[] = [];
    let excessive = false;
    const transport: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith('/changes/7'))
        return response({
          recordId: recordIds[0],
          relatedRecordIds: recordIds.slice(1),
          mergedIntoId: null,
        });
      if (path.includes('/runtime/kv/')) return response(null);
      calls.push(body);
      if (path.endsWith('/runtime/last-contact') && excessive)
        return response({ error: { code: 'derivation_fanout_exceeded', message: 'rescan' } }, 422);
      return response({
        processed: body?.recordIds?.length ?? 0,
        changed: 0,
        nextAfter: null,
        through: null,
      });
    };
    expect(
      await executeLastContact(
        invocation(LAST_CONTACT.person, { changePosition: '7' }),
        signal(),
        transport,
      ),
    ).toEqual({ status: 'succeeded' });
    expect(calls.map((body) => body.recordIds.length)).toEqual([20, 5]);
    calls.length = 0;
    excessive = true;
    await executeLastContact(
      invocation(LAST_CONTACT.conversation, { changePosition: '7' }),
      signal(),
      transport,
    );
    expect(calls.at(-1).children[0].input).toEqual({});
    expect(calls.at(-1).kv.value.after).toBeNull();
  });
  it('refuses supplied values or record cursors in durable job input before making any API call', async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      throw new Error('unexpected');
    };
    expect(
      await executeLastContact(
        invocation(LAST_CONTACT.scan, { after: randomUUID() }),
        signal(),
        transport,
      ),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
    expect(
      await executeLastContact(
        invocation(LAST_CONTACT.person, { changePosition: '1', value: '2099-01-01' }),
        signal(),
        transport,
      ),
    ).toEqual({ status: 'failed', code: 'invalid_input' });
    expect(calls).toBe(0);
  });
});
