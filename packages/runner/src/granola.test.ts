import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Invocation, VerificationInvocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeGranola, granolaParticipants } from './granola.js';
import { GRANOLA, granolaManifest, granolaNote } from './granola-contract.js';
import { GranolaProvider } from './granola-provider.js';
import { verifyWebhook } from './webhooks.js';

const noteId = 'not_123456789abcde';
const note = () => ({
  id: noteId,
  title: 'Shared meeting',
  owner: { email: 'owner@example.com', name: 'Owner' },
  created_at: '2026-11-10T10:00:00Z',
  updated_at: '2026-11-10T11:00:00Z',
  deleted_at: null,
  web_url: 'https://notes.granola.ai/d/meeting',
  summary_text: 'Shared summary',
  private_notes_text: 'NEVER IMPORT',
  attachments: [{ url: 'https://private.example/photo' }],
  attendees: [{ email: 'attendee@example.com', name: 'Attendee' }],
  calendar_event: {
    organiser: 'owner@example.com',
    invitees: [{ email: 'invitee@example.com' }],
    scheduled_start_time: '2026-11-10T09:00:00Z',
  },
  transcript: [
    {
      speaker: { source: 'microphone', diarization_label: 'Speaker A' },
      text: 'Complete first segment',
      start_time: '2026-11-10T09:00:00Z',
      end_time: '2026-11-10T09:00:02Z',
    },
  ],
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signal = () => new AbortController().signal;
const invocation = (functionId: string, input: unknown = {}): Invocation => ({
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: randomUUID(),
  releaseDigest: 'a'.repeat(64),
  functionId,
  input: input as Invocation['input'],
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_granola',
  deadline: new Date(Date.now() + 120000).toISOString(),
});
const settings = {
  shareAccessibleNotes: true,
  backfillDays: 31,
  webhooks: false,
  createPeople: 'never',
};

describe('reviewed Granola contract and bounded provider transport', () => {
  it('builds a pinned polling-capable release with explicit sharing and safe contact defaults', () => {
    const manifest = granolaManifest({
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      verifierDigest: 'c'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    });
    expect(manifest.source?.scanFunctionIds).toEqual([GRANOLA.scan, GRANOLA.schedule]);
    expect(manifest.settings.shareAccessibleNotes).toMatchObject({
      consent: true,
      required: true,
      default: false,
    });
    expect(manifest.settings.createPeople?.default).toBe('never');
    expect(manifest.webhooks?.[0]?.optional).toBe(true);
  });
  it('uses fixed public paths, provider-only credentials, redirect refusal and complete paginated transcripts', async () => {
    const calls: URL[] = [];
    const transport: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      calls.push(u);
      expect(u.origin).toBe('https://public-api.granola.ai');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-key');
      expect(init?.redirect).toBe('error');
      if (u.searchParams.has('include')) return response({}, 413);
      if (u.pathname.endsWith('/transcript'))
        return response({
          transcript: [
            {
              ...note().transcript[0],
              text: u.searchParams.has('cursor') ? 'Last segment' : 'First segment',
            },
          ],
          hasMore: !u.searchParams.has('cursor'),
          cursor: u.searchParams.has('cursor') ? null : 'opaque',
        });
      return response({ ...note(), transcript: undefined });
    };
    const result = await new GranolaProvider('provider-key', signal(), transport).note(
      noteId.toUpperCase(),
    );
    expect(result.transcript?.map((s) => s.text)).toEqual(['First segment', 'Last segment']);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('NEVER IMPORT');
    expect(JSON.stringify(result)).not.toContain('private.example');
  });
  it('refuses a mixed revision when a note changes during paginated transcript retrieval', async () => {
    let metadata = 0;
    const transport: typeof fetch = async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.has('include')) return response({}, 413);
      if (u.pathname.endsWith('/transcript'))
        return response({ transcript: note().transcript, hasMore: false, cursor: null });
      metadata++;
      return response({
        ...note(),
        updated_at: metadata === 1 ? note().updated_at : '2026-11-10T12:00:00Z',
      });
    };
    await expect(
      new GranolaProvider('key', signal(), transport).note(noteId),
    ).rejects.toMatchObject({ code: 'provider_revision_changed', retry: true });
  });
  it('never treats an unprocessed 404 as deletion and bounds retry-after without retaining error bodies', async () => {
    for (const [status, code, retry] of [
      [404, 'provider_note_unavailable', true],
      [401, 'provider_unauthorized', false],
      [403, 'provider_unauthorized', false],
      [429, 'provider_rate_limited', true],
      [503, 'provider_unavailable', true],
    ] as const) {
      const transport: typeof fetch = async () =>
        new Response('sensitive provider response', {
          status,
          headers: { 'retry-after': '99999' },
        });
      await expect(
        new GranolaProvider('key', signal(), transport).note(noteId),
      ).rejects.toMatchObject({ code, retry, message: code });
    }
    const provider = new GranolaProvider('key', signal(), async () => response({}));
    await expect(provider.request('/v1/notes/../../private', z.unknown())).rejects.toMatchObject({
      code: 'invalid_provider_path',
    });
  });
  it('rejects wrong provider identity and stalled transcript pagination', async () => {
    await expect(
      new GranolaProvider('key', signal(), async () =>
        response({ ...note(), id: 'not_abcdefghijklmn' }),
      ).note(noteId),
    ).rejects.toMatchObject({ code: 'provider_identity_mismatch' });
    const provider = new GranolaProvider('key', signal(), async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.has('include')) return response({}, 413);
      if (u.pathname.endsWith('/transcript'))
        return response({ transcript: [], hasMore: true, cursor: 'same' });
      return response(note());
    });
    await expect(provider.note(noteId)).rejects.toMatchObject({
      code: 'provider_pagination_stalled',
    });
  });
  it('derives contact evidence only from explicit owner-organizer equality', () => {
    const original = granolaNote.parse(note());
    expect(granolaParticipants(original)).toEqual([
      { email: 'owner@example.com', name: 'Owner', contacted: false },
      { email: 'attendee@example.com', name: 'Attendee', contacted: true },
      { email: 'invitee@example.com', contacted: true },
    ]);
    if (!original.calendar_event) throw new Error('missing calendar fixture');
    original.calendar_event.organiser = 'someone-else@example.com';
    expect(granolaParticipants(original).every((p) => !p.contacted)).toBe(true);
  });
  it('verifies generated, edited and access-granted payloads but refuses a signed event-id mismatch', async () => {
    const key = randomBytes(32),
      stamp = String(Math.floor(Date.now() / 1000)),
      eventId = randomUUID();
    const signed = (eventType: string, payloadId = eventId): VerificationInvocation => {
      const body = JSON.stringify({
        event_id: payloadId,
        event_type: eventType,
        note_id: noteId.toUpperCase(),
        occurred_at: new Date().toISOString(),
        data: { changed_fields: ['summary'] },
      });
      return {
        protocolVersion: 1,
        kind: 'webhook',
        verificationId: randomUUID(),
        releaseDigest: 'a'.repeat(64),
        functionId: GRANOLA.verifier,
        rawBody: Buffer.from(body).toString('base64'),
        secret: `whsec_${key.toString('base64')}`,
        deadline: new Date(Date.now() + 5000).toISOString(),
        headers: {
          'webhook-id': eventId,
          'webhook-timestamp': stamp,
          'webhook-signature': `v1,${createHmac('sha256', key).update(`${eventId}.${stamp}.${body}`).digest('base64')}`,
        },
      };
    };
    for (const event of ['note.generated', 'note.edited', 'note.access_granted'])
      expect(await verifyWebhook(signed(event))).toEqual({
        status: 'verified',
        deliveryId: eventId,
        externalId: noteId,
      });
    expect(await verifyWebhook(signed('note.edited', randomUUID()))).toEqual({
      status: 'rejected',
    });
    expect(await verifyWebhook(signed('note.deleted'))).toEqual({ status: 'rejected' });
  });
});

describe('Granola durable enumeration', () => {
  it('follows empty pages, atomically checkpoints local item children, and never puts provider IDs or cursors in job inputs', async () => {
    const scan = {
        scanId: randomUUID(),
        from: '2026-11-10T00:00:00.000Z',
        through: '2026-11-10T12:00:00.000Z',
        mode: 'created',
      },
      run = invocation(GRANOLA.scan, scan),
      itemId = randomUUID();
    let kv: any = null,
      providerPages = 0;
    const checkpoints: any[] = [];
    const transport: typeof fetch = async (url, init) => {
      const u = new URL(String(url)),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (u.origin === 'https://public-api.granola.ai') {
        providerPages++;
        return response(
          providerPages === 1
            ? { notes: [], hasMore: true, cursor: 'private-provider-cursor' }
            : {
                notes: [{ id: noteId, updated_at: note().updated_at }],
                hasMore: false,
                cursor: null,
              },
        );
      }
      if (u.pathname.endsWith('/runtime/secrets/apiKey'))
        return response({ value: 'provider-key', revision: 1 });
      if (u.pathname.endsWith(`/extensions/${run.installationId}`)) return response({ settings });
      if (u.pathname.endsWith('/source-sync'))
        return response(
          body
            ? { scanId: scan.scanId }
            : { lastSuccessfulScanAt: null, activeScan: scan, pendingItems: 0, failedItems: 0 },
        );
      if (u.pathname.includes('/runtime/kv/')) return response(kv);
      if (u.pathname.endsWith('/source')) return response({ sourceAccountId: randomUUID() });
      if (u.pathname.endsWith('/source-items/batch'))
        return response({
          items: [
            { externalId: noteId, sourceItemId: itemId, state: 'reserved', providerRevision: null },
          ],
        });
      if (u.pathname.endsWith('/runtime/checkpoint')) {
        checkpoints.push(body);
        kv = { revision: (kv?.revision ?? 0) + 1, value: body.kv.value };
        return response({ ids: [] });
      }
      throw new Error(`Unexpected fixture path ${u.pathname}`);
    };
    expect(await executeGranola(run, signal(), transport)).toEqual({ status: 'succeeded' });
    expect(checkpoints[0].children).toHaveLength(1);
    expect(checkpoints[0].scanComplete).toBeUndefined();
    expect(JSON.stringify(checkpoints[0].children)).not.toContain('private-provider-cursor');
    expect(await executeGranola({ ...run, runId: randomUUID() }, signal(), transport)).toEqual({
      status: 'succeeded',
    });
    expect(checkpoints[1].scanComplete).toEqual({ scanId: scan.scanId, through: scan.through });
    expect(checkpoints[1].children).toEqual([
      { functionId: GRANOLA.sync, input: { sourceItemId: itemId }, dedupeKey: expect.any(String) },
    ]);
    expect(JSON.stringify(checkpoints[1].children)).not.toContain(noteId);
  });
  it('retries only conflicts a later attempt can resolve', async () => {
    const run = invocation(GRANOLA.scan, {
      scanId: randomUUID(),
      from: '2026-11-10T00:00:00.000Z',
      through: '2026-11-10T12:00:00.000Z',
      mode: 'created',
    });
    const conflicted =
      (code: string): typeof fetch =>
      async () =>
        response({ error: { code, message: 'conflict' } }, 409);
    expect(await executeGranola(run, signal(), conflicted('source_retracted'))).toEqual({
      status: 'failed',
      code: 'source_api_rejected',
    });
    expect(await executeGranola(run, signal(), conflicted('revision_conflict'))).toEqual({
      status: 'retry',
      code: 'source_checkpoint_conflict',
      retryAfterSeconds: 30,
    });
  });
  it('polls edits of old notes without a created-after filter and keeps a fixed upper watermark', async () => {
    const run = invocation(GRANOLA.schedule),
      last = '2026-11-01T12:00:00Z';
    let checkpoint: any;
    const transport: typeof fetch = async (url, init) => {
      const u = new URL(String(url)),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (u.pathname.endsWith('/runtime/secrets/apiKey'))
        return response({ value: 'key', revision: 1 });
      if (u.pathname.endsWith(`/extensions/${run.installationId}`)) return response({ settings });
      if (u.pathname.endsWith('/source-sync'))
        return response(
          body
            ? {}
            : { lastSuccessfulScanAt: last, activeScan: null, pendingItems: 0, failedItems: 1 },
        );
      if (u.pathname.endsWith('/runtime/checkpoint')) {
        checkpoint = body;
        return response({});
      }
      throw new Error('unexpected transport');
    };
    expect(await executeGranola(run, signal(), transport)).toEqual({ status: 'succeeded' });
    const scan = checkpoint.children[0].input;
    expect(scan.mode).toBe('updated');
    // A fixed two-day catch-up behind the watermark re-lists notes whose import failed after it.
    expect(scan.from).toBe('2026-10-30T12:00:00.000Z');
    const failedNote = 'not_failedimport01',
      unchangedItem = randomUUID(),
      failedItem = randomUUID();
    const pageTransport: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.origin === 'https://public-api.granola.ai') {
        expect(u.searchParams.has('created_after')).toBe(false);
        expect(u.searchParams.get('updated_after')).toBe(scan.from);
        return response({
          notes: [
            { id: noteId, updated_at: note().updated_at },
            { id: failedNote, updated_at: '2026-10-31T09:00:00Z' },
          ],
          hasMore: false,
          cursor: null,
        });
      }
      if (u.pathname.endsWith('/source-items/batch'))
        return response({
          items: [
            {
              externalId: noteId,
              sourceItemId: unchangedItem,
              state: 'live',
              providerRevision: note().updated_at,
            },
            {
              externalId: failedNote,
              sourceItemId: failedItem,
              state: 'reserved',
              providerRevision: null,
            },
          ],
        });
      if (u.pathname.includes('/runtime/kv/')) return response(null);
      if (u.pathname.endsWith('/source')) return response({ sourceAccountId: randomUUID() });
      if (u.pathname.endsWith('/source-sync'))
        return response({ activeScan: scan, lastSuccessfulScanAt: last });
      return transport(url, init);
    };
    expect(
      await executeGranola(
        { ...run, functionId: GRANOLA.scan, input: scan },
        signal(),
        pageTransport,
      ),
    ).toEqual({ status: 'succeeded' });
    expect(checkpoint.scanComplete.through).toBe(scan.through);
    // Re-listing an unchanged live note enqueues no import; only the failed one is retried.
    expect(checkpoint.children).toEqual([
      {
        functionId: GRANOLA.sync,
        input: { sourceItemId: failedItem },
        dedupeKey: expect.any(String),
      },
    ]);
  });
});

describe('Granola owned webhook setup and cleanup', () => {
  const callback = `https://retainer.test/extensions/hooks/installations/${randomUUID()}/notes`;
  const endpoint = (id = 'whe_123456789abcde', url = callback) => ({
    id,
    url,
    url_redacted: false,
    scopes: ['workspace'],
    created_by: null,
    enabled: true,
    events: ['note.generated', 'note.edited', 'note.access_granted'],
    folder_ids: [],
  });
  it.each([
    [true, 2, true],
    [false, 2, true],
    [false, 1, false],
  ] as const)(
    'recovers only owned endpoints and reuses only the same proven credential (lost: %s, revision: %s)',
    async (lostSigning, apiKeyRevision, recreated) => {
      const run = invocation(GRANOLA.setup),
        secret = `whsec_${randomBytes(32).toString('base64')}`;
      const calls: { path: string; method: string; body: any }[] = [];
      let bound = false;
      const transport: typeof fetch = async (url, init) => {
        const u = new URL(String(url)),
          method = init?.method ?? 'GET',
          body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ path: u.pathname, method, body });
        if (u.origin === 'https://public-api.granola.ai') {
          if (u.pathname === '/v1/notes')
            return response({ notes: [], hasMore: false, cursor: null });
          if (method === 'DELETE') return new Response(null, { status: 204 });
          if (method === 'POST')
            return response({ ...endpoint('whe_abcdefghijklmn'), signing_secret: secret });
          return response({
            webhook_endpoints: [
              endpoint(),
              endpoint('whe_abcdefghijklmn', 'https://unrelated.example/hook'),
              { ...endpoint('whe_123456789abcdf'), url_redacted: true },
            ],
          });
        }
        if (u.pathname.endsWith('/runtime/secrets/apiKey'))
          return response({ value: 'workspace-key', revision: apiKeyRevision });
        if (u.pathname.endsWith(`/extensions/${run.installationId}`))
          return response({ settings: { ...settings, webhooks: true } });
        if (u.pathname.endsWith('/source/verify'))
          return response({ sourceAccountId: randomUUID() });
        if (u.pathname.endsWith('/source-sync'))
          return response(body ? {} : { lastSuccessfulScanAt: null, activeScan: null });
        if (u.pathname.endsWith('/runtime/checkpoint')) return response({});
        if (u.pathname.includes('/runtime/kv/'))
          return response({
            revision: 1,
            value: { apiKeyRevision: 1, signingRevision: 1, subscriptionId: 'whe_123456789abcde' },
          });
        if (u.pathname.endsWith('/runtime/webhooks/prepare'))
          return response({ bindingId: 'own-binding', url: callback });
        if (u.pathname.endsWith('/runtime/secrets/signing')) {
          if (method === 'GET' && !lostSigning) return response({ value: secret, revision: 1 });
          if (method === 'GET')
            return response(
              { error: { code: 'connection_required', message: 'no signing key' } },
              409,
            );
          expect(body).toEqual({ expectedRevision: lostSigning ? null : 1, value: secret });
          return response({ revision: 1 });
        }
        if (u.pathname.endsWith('/runtime/webhooks')) {
          if (method === 'GET')
            return response({
              bindings: [
                {
                  bindingId: 'own-binding',
                  route: 'notes',
                  url: callback,
                  state: 'active',
                  subscriptionId: 'whe_123456789abcde',
                },
              ],
            });
          expect(body).toEqual({
            route: 'notes',
            subscriptionId: recreated ? 'whe_abcdefghijklmn' : 'whe_123456789abcde',
          });
          bound = true;
          return response({ bindingId: 'own-binding', url: callback });
        }
        throw new Error(`Unexpected fixture ${u.pathname}`);
      };
      expect(await executeGranola(run, signal(), transport)).toEqual({ status: 'succeeded' });
      expect(bound).toBe(true);
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(
        recreated ? ['/v1/webhook-endpoints/whe_123456789abcde'] : [],
      );
      if (!recreated) {
        expect(
          calls.filter((c) => c.path.endsWith('/runtime/secrets/signing') && c.method !== 'GET'),
        ).toHaveLength(0);
        return;
      }
      expect(
        calls.find((c) => c.path === '/v1/webhook-endpoints' && c.method === 'POST')?.body,
      ).toEqual({
        url: callback,
        scopes: ['workspace'],
        events: ['note.access_granted', 'note.edited', 'note.generated'],
      });
    },
  );
  it('requires explicit workspace scope even when a provider endpoint has no surviving creator', async () => {
    const run = invocation(GRANOLA.setup);
    const transport: typeof fetch = async (url, init) => {
      const u = new URL(String(url)),
        method = init?.method ?? 'GET';
      if (u.origin === 'https://public-api.granola.ai') {
        if (u.pathname === '/v1/notes')
          return response({ notes: [], hasMore: false, cursor: null });
        if (method === 'POST')
          return response({
            ...endpoint(),
            scopes: ['personal'],
            signing_secret: `whsec_${randomBytes(32).toString('base64')}`,
          });
        return response({ webhook_endpoints: [] });
      }
      if (u.pathname.endsWith('/runtime/secrets/apiKey'))
        return response({ value: 'key', revision: 1 });
      if (u.pathname.endsWith(`/extensions/${run.installationId}`))
        return response({ settings: { ...settings, webhooks: true } });
      if (u.pathname.endsWith('/source/verify')) return response({});
      if (u.pathname.includes('/runtime/kv/')) return response(null);
      if (u.pathname.endsWith('/runtime/webhooks/prepare'))
        return response({ bindingId: 'own', url: callback });
      if (u.pathname.endsWith('/runtime/webhooks')) return response({ bindings: [] });
      if (u.pathname.endsWith('/runtime/secrets/signing'))
        return response({ error: { code: 'connection_required' } }, 409);
      throw new Error('unexpected write after failed ownership proof');
    };
    expect(await executeGranola(run, signal(), transport)).toEqual({
      status: 'failed',
      code: 'provider_workspace_key_required',
    });
  });
  it('uninstalls only exact unredacted owned endpoints without reading CRM or invoking a scan', async () => {
    const run = invocation(GRANOLA.cleanup),
      deleted: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/runtime/secrets/apiKey'))
        return response({ value: 'key', revision: 1 });
      if (u.origin === 'https://retainer.test') {
        expect(u.pathname.endsWith('/runtime/webhooks')).toBe(true);
        return response({ bindings: [{ url: callback, state: 'retired' }] });
      }
      if (init?.method === 'DELETE') {
        deleted.push(u.pathname);
        return new Response(null, { status: 204 });
      }
      return response({
        webhook_endpoints: [
          endpoint(),
          endpoint('whe_abcdefghijklmn', 'https://elsewhere.example'),
          { ...endpoint('whe_123456789abcdf'), url_redacted: true },
        ],
      });
    };
    expect(await executeGranola(run, signal(), transport)).toEqual({ status: 'succeeded' });
    expect(deleted).toEqual(['/v1/webhook-endpoints/whe_123456789abcde']);
  });
});

describe('Granola cursor recovery', () => {
  it('narrows an initial backfill window without advancing success, but visibly refuses an unbounded incremental restart', async () => {
    for (const mode of ['created', 'updated'] as const) {
      const scan = {
          scanId: randomUUID(),
          mode,
          from: '2026-11-10T00:00:00.000Z',
          through: '2026-11-11T00:00:00.000Z',
        },
        run = invocation(GRANOLA.scan, scan);
      let checkpoint: any = null;
      const saved = {
        revision: 1,
        value: {
          scanId: scan.scanId,
          epoch: randomUUID(),
          page: 7,
          windowStart: Date.parse(scan.from),
          windowEnd: Date.parse(scan.through),
          windowSpan: 86400000,
          cursor: 'expired-private-cursor',
          cursorHashes: ['a'.repeat(64)],
          done: false,
        },
      };
      const transport: typeof fetch = async (url, init) => {
        const u = new URL(String(url)),
          body = init?.body ? JSON.parse(String(init.body)) : null;
        if (u.origin === 'https://public-api.granola.ai')
          return response({ sensitive: 'do not retain' }, 400);
        if (u.pathname.endsWith('/runtime/secrets/apiKey'))
          return response({ value: 'key', revision: 1 });
        if (u.pathname.endsWith(`/extensions/${run.installationId}`)) return response({ settings });
        if (u.pathname.endsWith('/source-sync'))
          return response({ activeScan: scan, lastSuccessfulScanAt: null });
        if (u.pathname.includes('/runtime/kv/')) return response(saved);
        if (u.pathname.endsWith('/source')) return response({ sourceAccountId: randomUUID() });
        if (u.pathname.endsWith('/runtime/checkpoint')) {
          checkpoint = body;
          return response({});
        }
        throw new Error('unexpected fixture call');
      };
      const result = await executeGranola(run, signal(), transport);
      if (mode === 'updated') {
        expect(result).toEqual({ status: 'failed', code: 'provider_cursor_recovery_required' });
        expect(checkpoint).toBeNull();
      } else {
        expect(result).toEqual({ status: 'succeeded' });
        expect(checkpoint.scanComplete).toBeUndefined();
        expect(checkpoint.children[0].input).toEqual(scan);
        expect(checkpoint.kv.value).toMatchObject({
          windowEnd: Date.parse('2026-11-10T12:00:00Z'),
          cursor: null,
          cursorHashes: [],
        });
        expect(JSON.stringify(checkpoint)).not.toContain('expired-private-cursor');
      }
    }
  });
});
