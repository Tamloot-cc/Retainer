import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionManifest } from '@retainer/extension';
import { BASE_EVENT_TYPE_IDS, type SourceEventImport, type SourceScan } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createFileServer, LocalFileStorage } from '../../src/file-storage/local.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
let storage: LocalFileStorage,
  server: ReturnType<typeof createFileServer>,
  directory: string,
  tokens: RunTokens;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-sources-'));
  const key = randomBytes(32);
  server = createFileServer({ directory, key });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing storage address');
  storage = new LocalFileStorage(`http://127.0.0.1:${address.port}`, key);
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'sources',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function setup(
  policy: 'never' | 'contacted_first' | 'everyone' = 'never',
  verify = true,
  onSourceDelete: 'keep' | 'retract' = 'keep',
  extra?: ExtensionManifest,
) {
  const verifyId = randomUUID(),
    syncId = randomUUID(),
    backfillId = randomUUID();
  const fn = (
    id: string,
    name: string,
    trigger: { kind: 'job' } | { kind: 'install' },
    inputSchema: Record<string, unknown>,
  ) => ({
    universalId: id,
    name,
    description: 'Source fixture',
    handlerDigest: 'b'.repeat(64),
    trigger,
    inputSchema,
    timeoutSeconds: 120,
  });
  const manifest = extensionFixture({
    scopes: ['read', 'write'],
    createPeople: policy,
    onSourceDelete,
    source: {
      provider: 'fixture',
      identity: 'account',
      verifyFunctionId: verifyId,
      syncFunctionIds: [syncId],
      scanFunctionIds: [backfillId],
      eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
      revisionOrder: 'integer',
    },
    functions: [
      fn(verifyId, 'verify', { kind: 'install' }, { type: 'object', additionalProperties: false }),
      fn(
        syncId,
        'sync',
        { kind: 'job' },
        {
          type: 'object',
          properties: { sourceItemId: { type: 'string', maxLength: 36 } },
          required: ['sourceItemId'],
          additionalProperties: false,
        },
      ),
      fn(
        backfillId,
        'backfill',
        { kind: 'job' },
        {
          type: 'object',
          properties: {
            scanId: { type: 'string' },
            from: { type: 'string' },
            through: { type: 'string' },
            mode: { type: 'string' },
          },
          additionalProperties: false,
        },
      ),
    ] as ExtensionManifest['functions'],
  });
  const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ...(extra
      ? [{ manifest: extra, actorCeiling: 'integration' as const, runtimeEnabled: true }]
      : []),
  ]);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    fileStorage: storage,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Sources ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'research' }, scopes: ['read', 'write'] },
    },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    base = `/v1/extensions/${id}`;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const [pending] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const setupRun = await queue.claim(workspace.id, pending?.id, 'setup');
  if (!setupRun) throw new Error('setup run missing');
  const token = (run: ClaimedJob) => tokens.issue(app.sql, run, manifest.universalId, run.scopes);
  const setupToken = await token(setupRun);
  let accountId = '';
  if (verify) {
    const verified = await app.request(`${base}/source/verify`, {
      key: setupToken,
      body: { accountId: 'provider-workspace-1', sharing: 'workspace' },
    });
    expect(verified.status).toBe(200);
    accountId = verified.body.sourceAccountId;
    await queue.complete(setupRun, { status: 'succeeded' });
  }
  async function start(item?: string, scan?: SourceScan) {
    const job = await queue.enqueue(workspace.id, id, {
      functionId: item ? syncId : backfillId,
      input: item ? { sourceItemId: item } : (scan ?? {}),
      dedupeKey: randomUUID(),
    });
    const run = await queue.claim(workspace.id, job.id, 'source-worker');
    if (!run) throw new Error('source run missing');
    return { run, key: await token(run) };
  }
  async function reserve(key: string, externalId = `note-${randomUUID()}`) {
    const response = await app.request(`${base}/source-items`, {
      key,
      body: { sourceAccountId: accountId, externalId },
    });
    expect(response.status).toBe(201);
    return response.body.sourceItemId as string;
  }
  async function item(externalId?: string) {
    const scan = await start(),
      itemId = await reserve(scan.key, externalId);
    await queue.complete(scan.run, { status: 'succeeded' });
    return { itemId, ...(await start(itemId)) };
  }
  const event = (title = 'First', participants: { email: string; contacted?: boolean }[] = []) => ({
    type: BASE_EVENT_TYPE_IDS.conversation,
    occurredAt: '2026-11-10T10:00:00Z',
    title,
    participants,
  });
  const sync = (
    key: string,
    itemId: string,
    revision: string,
    expected: string | null,
    eventBody: SourceEventImport['event'] = event(),
  ) =>
    app.request(`${base}/source-events`, {
      key,
      body: {
        sourceItemId: itemId,
        providerRevision: revision,
        expectedRevisionId: expected,
        event: eventBody,
      },
    });
  return {
    app,
    workspace,
    keys,
    manifest,
    id,
    base,
    queue,
    setupRun,
    setupToken,
    accountId,
    start,
    reserve,
    item,
    event,
    sync,
    syncId,
    backfillId,
    token,
  };
}

describe('managed source evidence with real RLS Postgres', () => {
  const scanInput = (): SourceScan => ({
    scanId: randomUUID(),
    mode: 'created',
    from: new Date(Date.now() - 86400000).toISOString(),
    through: new Date().toISOString(),
  });
  it('serializes competing scan starts and atomically completes enumeration with durable import children', async () => {
    const h = await setup(),
      scan = scanInput(),
      run = await h.start(undefined, scan);
    const starts = await Promise.all(
      [scan, { ...scan, scanId: randomUUID() }].map((body) =>
        h.app.request(`${h.base}/source-sync`, { key: run.key, body }),
      ),
    );
    expect(starts.map((r) => r.status).sort()).toEqual([200, 409]);
    // Either contender can win. Bind the final-page job to the actual winning bounds.
    const status = await h.app.request(`${h.base}/source-sync`, { key: h.keys.admin });
    expect(status.status).toBe(200);
    const winning = status.body.activeScan;
    expect(winning).toMatchObject({ mode: scan.mode, from: scan.from, through: scan.through });
    await h.queue.complete(run.run, { status: 'succeeded' });
    const final = await h.start(undefined, {
      scanId: winning.scanId,
      mode: winning.mode,
      from: winning.from,
      through: winning.through,
    });
    const item = await h.reserve(final.key);
    const complete = { scanId: winning.scanId, through: winning.through };
    // A failed child admission cannot leave a false successful scan or KV checkpoint.
    const rejected = await h.app.request(`${h.base}/runtime/checkpoint`, {
      key: final.key,
      body: {
        children: [{ functionId: randomUUID(), input: {}, dedupeKey: 'invalid' }],
        kv: { key: 'page', expectedRevision: null, value: { done: true } },
        scanComplete: complete,
      },
    });
    expect(rejected.status).toBe(422);
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: final.key })).body.lastSuccessfulScanAt,
    ).toBeNull();
    const checkpoint = await h.app.request(`${h.base}/runtime/checkpoint`, {
      key: final.key,
      body: {
        children: [
          { functionId: h.syncId, input: { sourceItemId: item }, dedupeKey: 'final-import' },
        ],
        kv: { key: 'page', expectedRevision: null, value: { done: true } },
        scanComplete: complete,
      },
    });
    expect(checkpoint.status).toBe(200);
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: h.keys.admin })).body,
    ).toMatchObject({
      lastSuccessfulScanAt: winning.through,
      activeScan: null,
      pendingItems: 1,
      failedItems: 0,
    });
    await h.queue.complete(final.run, { status: 'succeeded' });
    const child = await h.queue.claim(h.workspace.id, checkpoint.body.ids[0], 'import');
    if (!child) throw new Error('missing import child');
    await h.queue.complete(child, { status: 'failed', code: 'provider_unavailable' });
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: h.keys.admin })).body,
    ).toMatchObject({
      lastSuccessfulScanAt: winning.through,
      pendingItems: 0,
      failedItems: 1,
    });
    expect(
      (await h.app.request(`${h.base}/source/disconnect`, { key: h.keys.admin, body: {} })).status,
    ).toBe(200);
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: h.keys.admin })).body,
    ).toMatchObject({
      lastSuccessfulScanAt: null,
      activeScan: null,
      pendingItems: 0,
      failedItems: 0,
    });
  });
  it('rejects forged scan completion, bounds changes, unrelated installation credentials and stale leases', async () => {
    const h = await setup(),
      scan = scanInput(),
      run = await h.start(undefined, scan);
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: h.keys.admin, body: scan })).status,
    ).toBe(404);
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: run.key, body: scan })).status,
    ).toBe(200);
    expect(
      (
        await h.app.request(`${h.base}/source-sync`, {
          key: run.key,
          body: { ...scan, from: new Date(Date.now() - 172800000).toISOString() },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await h.app.request(`${h.base}/runtime/checkpoint`, {
          key: run.key,
          body: {
            children: [],
            kv: { key: 'page', expectedRevision: null, value: 'must rollback' },
            scanComplete: { scanId: randomUUID(), through: scan.through },
          },
        })
      ).status,
    ).toBe(403);
    expect(await h.queue.getKv(run.run, 'page')).toBeNull();
    const other = await setup(),
      otherRun = await other.start();
    expect((await h.app.request(`${h.base}/source-sync`, { key: otherRun.key })).status).toBe(404);
    await h.queue.complete(run.run, { status: 'succeeded' });
    const itemRun = await h.item();
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: itemRun.key, body: scan })).status,
    ).toBe(403);
    expect(
      (
        await h.app.request(`${h.base}/runtime/checkpoint`, {
          key: itemRun.key,
          body: { children: [], scanComplete: { scanId: scan.scanId, through: scan.through } },
        })
      ).status,
    ).toBe(403);
    expect((await h.app.request(`${h.base}/disable`, { key: h.keys.admin, body: {} })).status).toBe(
      200,
    );
    expect(
      (await h.app.request(`${h.base}/source-sync`, { key: itemRun.key, body: scan })).status,
    ).toBe(409);
  });
  it('reserves provider pages concurrently with explicit erased-item outcomes and no cross-account authority', async () => {
    const h = await setup(),
      erased = await h.item('erased-note');
    const imported = await h.sync(erased.key, erased.itemId, '1', null);
    expect(imported.status).toBe(200);
    expect(
      (
        await h.app.request(`/v1/records/${imported.body.eventId}/forget`, {
          key: h.keys.admin,
          body: {},
        })
      ).status,
    ).toBe(200);
    const scan = await h.start();
    const connection = await h.app.request(`${h.base}/source`, { key: scan.key });
    expect(connection.body).toEqual({
      sourceAccountId: h.accountId,
      provider: 'fixture',
      identity: 'account',
    });
    expect((await h.app.request(`${h.base}/source`, { key: h.keys.admin })).status).toBe(404);
    const reserve = () =>
      h.app.request(`${h.base}/source-items/batch`, {
        key: scan.key,
        body: { sourceAccountId: h.accountId, externalIds: ['erased-note', 'surviving-note'] },
      });
    const results = await Promise.all([reserve(), reserve()]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(results[0]?.body).toEqual(results[1]?.body);
    expect(results[0]?.body.items[0]).toEqual({ externalId: 'erased-note', code: 'source_erased' });
    expect(results[0]?.body.items[1].sourceItemId).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      await db.owner`select id from source_items where workspace_id=${h.workspace.id} and external_id='surviving-note'`,
    ).toHaveLength(1);
    const rejected = await h.app.request(`${h.base}/source-items/batch`, {
      key: scan.key,
      body: { sourceAccountId: randomUUID(), externalIds: ['must-not-reserve'] },
    });
    expect(rejected.status).toBe(404);
    expect(
      await db.owner`select id from source_items where workspace_id=${h.workspace.id} and external_id='must-not-reserve'`,
    ).toHaveLength(0);
    expect(
      (
        await h.app.request(`${h.base}/source-items/batch`, {
          key: scan.key,
          body: { sourceAccountId: h.accountId, externalIds: ['duplicate', 'duplicate'] },
        })
      ).status,
    ).toBe(400);
  });
  it('repairs transient unavailability by replaying the same current immutable receipt', async () => {
    const h = await setup(),
      source = await h.item();
    const first = await h.sync(source.key, source.itemId, '1', null);
    expect(first.status).toBe(200);
    expect(
      (
        await h.app.request(`${h.base}/source-items/${source.itemId}/unavailable`, {
          key: source.key,
          body: { status: 'unavailable' },
        })
      ).status,
    ).toBe(200);
    expect((await h.sync(source.key, source.itemId, '1', null)).body).toEqual(first.body);
    const [item] = await db.owner`select state from source_items where id=${source.itemId}`;
    expect(item?.state).toBe('live');
    const second = await h.sync(
      source.key,
      source.itemId,
      '2',
      first.body.revisionId,
      h.event('Edited'),
    );
    expect(second.status).toBe(200);
    await h.app.request(`${h.base}/source-items/${source.itemId}/unavailable`, {
      key: source.key,
      body: { status: 'unavailable' },
    });
    expect((await h.sync(source.key, source.itemId, '1', null)).body).toEqual(first.body);
    const [stillUnavailable] =
      await db.owner`select state from source_items where id=${source.itemId}`;
    expect(stillUnavailable?.state).toBe('unavailable');
    expect(
      (await h.sync(source.key, source.itemId, '2', first.body.revisionId, h.event('Edited'))).body,
    ).toEqual(second.body);
    const [recovered] = await db.owner`select state from source_items where id=${source.itemId}`;
    expect(recovered?.state).toBe('live');
  });

  it('requires a pinned setup attestation and refuses ordinary credentials', async () => {
    const h = await setup('never', false);
    expect(
      (
        await h.app.request(`${h.base}/source/verify`, {
          key: h.keys.admin,
          body: { accountId: 'spoof', sharing: 'workspace' },
        })
      ).status,
    ).toBe(404);
    await h.queue.complete(h.setupRun, { status: 'succeeded' });
    const [i] =
      await db.owner`select state,last_error from extension_installations where id=${h.id}`;
    expect(i).toEqual({ state: 'setup_failed', last_error: 'source_verification_required' });
  });
  it('creates immutable revisions, retracts old derivatives and preserves explicit historical citations', async () => {
    const h = await setup(),
      source = await h.item();
    const person = await h.app.request('/v1/objects/person/records', {
      key: h.keys.admin,
      body: { values: { name: 'Dana', emails: 'dana@source.test', jobTitle: 'Human title' } },
    });
    const personId = person.body.id as string;
    const initial = await h.sync(
      source.key,
      source.itemId,
      '1',
      null,
      h.event('Original', [{ email: 'dana@source.test' }]),
    );
    expect(initial.status).toBe(200);
    const first = initial.body;
    const duplicate = await h.sync(
      source.key,
      source.itemId,
      '1',
      null,
      h.event('Original', [{ email: 'dana@source.test' }]),
    );
    expect(duplicate.body).toEqual(first);
    expect(
      (
        await h.app.request(`/v1/records/${personId}`, {
          key: h.keys.agent,
          method: 'PATCH',
          body: { values: { jobTitle: 'Derived title' }, source: first.eventId },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.request(`/v1/records/${personId}/facts`, {
          key: h.keys.agent,
          body: { text: 'Original note claim', source: first.eventId },
        })
      ).status,
    ).toBe(201);
    const edited = await h.sync(
      source.key,
      source.itemId,
      '2',
      first.revisionId,
      h.event('Edited', [{ email: 'dana@source.test' }]),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.eventId).not.toBe(first.eventId);
    expect(edited.body.previousEventId).toBe(first.eventId);
    expect(edited.body.invalidated.retractedAssertions).toBe(1);
    expect(edited.body.invalidated.hiddenFactIds).toHaveLength(1);
    expect(
      (await h.app.request(`/v1/records/${personId}`, { key: h.keys.admin })).body.fields.jobTitle,
    ).toBe('Human title');
    expect(
      (await h.app.request(`/v1/records/${personId}/facts`, { key: h.keys.admin })).body.facts,
    ).toEqual([]);
    const history = await h.app.request(`/v1/events/${first.eventId}`, { key: h.keys.admin });
    expect(history.body.event.title).toBe('Original');
    expect(history.body.event.source.current).toBe(false);
    const activity = await h.app.request('/v1/events/query', { key: h.keys.admin, body: {} });
    expect(activity.status).toBe(200);
    expect(activity.body.records.map((i: { id: string }) => i.id)).toEqual([edited.body.eventId]);
    expect(
      (
        await h.app.request(`/v1/records/${personId}`, {
          key: h.keys.agent,
          method: 'PATCH',
          body: { values: { jobTitle: 'Stale' }, source: first.eventId },
        })
      ).body.error.code,
    ).toBe('source_superseded');
    expect(
      (
        await h.app.request(`/v1/records/${first.eventId}`, {
          key: h.keys.admin,
          method: 'PATCH',
          body: { values: { title: 'Mutated' } },
        })
      ).body.error.code,
    ).toBe('immutable_source_revision');
    expect(
      (
        await h.app.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: {
            operations: [
              {
                op: 'create_object',
                object: {
                  nameSingular: 'sourceArchive',
                  namePlural: 'sourceArchives',
                  labelSingular: 'Archive',
                  labelPlural: 'Archives',
                  class: 'event',
                  fields: [],
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.request('/v1/events/move', {
          key: h.keys.admin,
          body: {
            from: 'conversation',
            to: 'sourceArchive',
            events: [first.eventId],
            dryRun: true,
          },
        })
      ).body.error.code,
    ).toBe('immutable_source_revision');
    await h.queue.complete(source.run, { status: 'succeeded' });
  });
  it('serializes competing edits and explicitly ignores older comparable provider versions', async () => {
    const h = await setup(),
      s = await h.item();
    const first = (await h.sync(s.key, s.itemId, '9', null)).body;
    const results = await Promise.all(
      ['10', '11'].map((revision) =>
        h.sync(s.key, s.itemId, revision, first.revisionId, h.event(`Edited ${revision}`)),
      ),
    );
    expect(results.filter((r) => r.status === 200 && r.body.created)).toHaveLength(1);
    expect(
      results.every(
        (r) => r.status === 409 || (r.status === 200 && (r.body.created || r.body.stale)),
      ),
    ).toBe(true);
    const winner = results.find((r) => r.status === 200 && r.body.created)?.body;
    expect(winner).toBeTruthy();
    const stale = await h.sync(s.key, s.itemId, '2', null, h.event('Old delivery'));
    expect(stale.status).toBe(200);
    expect(stale.body.stale).toBe(true);
    expect(stale.body.eventId).toBe(winner.eventId);
    const [count] =
      await db.owner`select count(*)::int as n from source_revisions where item_id=${s.itemId}`;
    expect(count?.n).toBe(2);
  });
  it('deduplicates simultaneous deliveries durably and checks canonical content rather than trusting a digest', async () => {
    const h = await setup(),
      s = await h.item();
    const responses = await Promise.all([
      h.sync(s.key, s.itemId, '1', null),
      h.sync(s.key, s.itemId, '1', null),
    ]);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses[0]?.body).toEqual(responses[1]?.body);
    expect(
      (await h.sync(s.key, s.itemId, '1', null, h.event('Conflicting replay'))).body.error.code,
    ).toBe('source_revision_conflict');
    const bad = await h.app.request(`${h.base}/source-events`, {
      key: s.key,
      body: {
        sourceItemId: s.itemId,
        providerRevision: '2',
        expectedRevisionId: responses[0]?.body.revisionId,
        contentDigest: 'a'.repeat(64),
        event: h.event('Wrong hash'),
      },
    });
    expect(bad.body.error.code).toBe('invalid_content_digest');
  });
  it('binds item access and ingestion authority to the installation and its current item job', async () => {
    const h = await setup(),
      scan = await h.start(),
      item = await h.reserve(scan.key);
    expect((await h.sync(scan.key, item, '1', null)).status).toBe(403);
    expect(
      (
        await h.app.request(`${h.base}/source/verify`, {
          key: scan.key,
          body: { accountId: 'spoof', sharing: 'workspace' },
        })
      ).status,
    ).toBe(403);
    await h.queue.complete(scan.run, { status: 'succeeded' });
    const s = await h.start(item);
    expect((await h.sync(s.key, randomUUID(), '1', null)).status).toBe(403);
    const other = await setup(),
      otherRun = await other.start();
    expect(
      (await h.app.request(`${h.base}/source-items/${item}`, { key: otherRun.key })).status,
    ).toBe(404);
    expect(
      (
        await h.app.request(`${h.base}/source-items`, {
          key: otherRun.key,
          body: { sourceAccountId: h.accountId, externalId: 'cross-workspace' },
        })
      ).status,
    ).toBe(404);
  });
  it('enforces never/everyone/contacted-first policies on the server', async () => {
    for (const policy of ['never', 'everyone', 'contacted_first'] as const) {
      const h = await setup(policy),
        s = await h.item();
      expect(
        (
          await h.sync(
            s.key,
            s.itemId,
            '1',
            null,
            h.event(policy, [
              { email: 'attendee@fixture.test' },
              { email: 'outbound@fixture.test', contacted: true },
            ]),
          )
        ).status,
      ).toBe(200);
      const [count] =
        await db.owner`select count(*)::int as n from record_identifiers where workspace_id=${h.workspace.id} and kind='email'`;
      expect(count?.n).toBe(policy === 'never' ? 0 : policy === 'everyone' ? 2 : 1);
    }
  });
  it('erases every revision and pending upload, fences old runs, preserves unrelated work, and suppresses reimport', async () => {
    const h = await setup('everyone'),
      external = 'private-note-identity',
      s = await h.item(external);
    const first = (
      await h.sync(
        s.key,
        s.itemId,
        '1',
        null,
        h.event('Private original', [{ email: 'forgotten@fixture.test' }]),
      )
    ).body;
    const edited = await h.sync(s.key, s.itemId, '2', first.revisionId, h.event('Private edited'));
    expect(edited.status).toBe(200);
    expect(
      (
        await h.app.request(`${h.base}/source-items/${s.itemId}/prepare`, {
          key: s.key,
          body: { participants: [] },
        })
      ).status,
    ).toBe(200);
    const pending = await h.app.request('/v1/files/intents', {
      key: s.key,
      headers: { 'Idempotency-Key': 'private-upload' },
      body: {
        name: 'private.txt',
        mediaType: 'text/plain',
        bytes: 12,
        sha256: 'a'.repeat(64),
        sourceItemId: s.itemId,
      },
    });
    expect(pending.status).toBe(201);
    const [person] =
      await db.owner`select record_id from record_identifiers where workspace_id=${h.workspace.id} and value='forgotten@fixture.test'`;
    const otherItem = await h.reserve(s.key, 'surviving-note');
    const survivor = await h.queue.enqueue(h.workspace.id, h.id, {
      functionId: h.syncId,
      input: { sourceItemId: otherItem },
      dedupeKey: 'surviving-work',
    });
    await h.queue.checkpoint(s.run, {
      children: [],
      kv: { key: 'cursor', expectedRevision: null, value: { last: external } },
    });
    const erased = await h.app.request(`/v1/records/${person?.record_id}/forget`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(erased.status).toBe(200);
    expect(erased.body.storage.pending).toBe(1);
    expect(
      (await h.sync(s.key, s.itemId, '3', edited.body.revisionId, h.event('Late fetched content')))
        .status,
    ).toBe(409);
    expect(
      await db.owner`select id from records where id=any(${[first.eventId, edited.body.eventId]}::uuid[])`,
    ).toHaveLength(0);
    expect(await db.owner`select id from source_revisions where item_id=${s.itemId}`).toHaveLength(
      0,
    );
    expect(await db.owner`select key from extension_kv where installation_id=${h.id}`).toHaveLength(
      0,
    );
    const [row] =
      await db.owner`select external_id,provider_revision,state from source_items where id=${s.itemId}`;
    expect(row).toEqual({ external_id: null, provider_revision: null, state: 'erased' });
    const [upload] = await db.owner`select metadata,state from files where id=${pending.body.id}`;
    expect(upload).toEqual({ metadata: {}, state: 'erasing' });
    const [job] = await db.owner`select input,status from extension_jobs where id=${s.run.jobId}`;
    expect(job).toEqual({ input: {}, status: 'cancelled' });
    const next = await h.queue.claim(h.workspace.id, survivor.id, 'after-erasure');
    expect(next).toBeTruthy();
    if (!next) throw new Error('unrelated durable work lost');
    const nextToken = await h.token(next);
    const reimport = await h.app.request(`${h.base}/source-items`, {
      key: nextToken,
      body: { sourceAccountId: h.accountId, externalId: external },
    });
    expect(reimport.body.error.code).toBe('source_erased');
    expect(
      (await h.sync(nextToken, otherItem, '1', null, h.event('Surviving source'))).status,
    ).toBe(200);
  });
  it('fences only the erased source installation and leaves unrelated installations running', async () => {
    const workId = randomUUID(),
      other = extensionFixture({
        scopes: ['read', 'write'],
        functions: [
          {
            universalId: workId,
            name: 'work',
            description: 'Unrelated durable work',
            handlerDigest: 'c'.repeat(64),
            timeoutSeconds: 120,
            trigger: { kind: 'job' },
            inputSchema: {
              type: 'object',
              properties: { page: { type: 'integer' } },
              additionalProperties: false,
            },
          },
        ] as ExtensionManifest['functions'],
      });
    const h = await setup('everyone', true, 'keep', other),
      s = await h.item();
    expect(
      (
        await h.sync(
          s.key,
          s.itemId,
          '1',
          null,
          h.event('Erased meeting', [{ email: 'forgotten@fixture.test' }]),
        )
      ).status,
    ).toBe(200);
    await h.queue.checkpoint(s.run, {
      children: [],
      kv: { key: 'cursor', expectedRevision: null, value: { page: 1 } },
    });
    const input = { registrationId: other.universalId, version: other.version, settings: {} };
    const plan = await h.app.request('/v1/extensions/preview', { key: h.keys.admin, body: input });
    const installed = await h.app.request('/v1/extensions', {
      key: h.keys.admin,
      body: { ...input, planDigest: plan.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status).toBe(201);
    const b = installed.body.id as string;
    const [lifecycle] =
      await db.owner`select id from extension_jobs where installation_id=${b} and trigger_kind='install'`;
    const setupB = await h.queue.claim(h.workspace.id, lifecycle?.id, 'setup');
    if (!setupB) throw new Error('setup missing');
    await h.queue.complete(setupB, { status: 'succeeded' });
    const work = await h.queue.enqueue(h.workspace.id, b, {
      functionId: workId,
      input: { page: 3 },
      dedupeKey: randomUUID(),
    });
    const running = await h.queue.claim(h.workspace.id, work.id, 'unrelated-worker');
    if (!running) throw new Error('unrelated run missing');
    await h.queue.checkpoint(running, {
      children: [],
      kv: { key: 'cursor', expectedRevision: null, value: { page: 3 } },
    });
    const snapshot = async () => ({
      installation:
        await db.owner`select generation,state from extension_installations where id=${b}`,
      jobs: await db.owner`select id,status,fence::text,generation,input,lease_owner from extension_jobs where installation_id=${b} order by id`,
      attempts:
        await db.owner`select id,status,code,finished_at from extension_attempts where job_id=${work.id} order by id`,
      kv: await db.owner`select key,value,revision from extension_kv where installation_id=${b}`,
    });
    const before = await snapshot();
    const [generationA] =
      await db.owner`select generation from extension_installations where id=${h.id}`;
    const [person] =
      await db.owner`select record_id from record_identifiers where workspace_id=${h.workspace.id} and value='forgotten@fixture.test'`;
    expect(
      (
        await h.app.request(`/v1/records/${person?.record_id}/forget`, {
          key: h.keys.admin,
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(before.kv).toHaveLength(1);
    expect(before.jobs.find((j) => j.id === work.id)?.status).toBe('running');
    const [afterA] =
      await db.owner`select generation from extension_installations where id=${h.id}`;
    expect(afterA?.generation).toBe((generationA?.generation ?? 0) + 1);
    expect(await db.owner`select key from extension_kv where installation_id=${h.id}`).toHaveLength(
      0,
    );
    const [cancelled] =
      await db.owner`select input,status from extension_jobs where id=${s.run.jobId}`;
    expect(cancelled).toEqual({ input: {}, status: 'cancelled' });
    const unrelatedKey = await tokens.issue(h.app.sql, running, other.universalId, running.scopes);
    expect(
      (
        await h.app.request('/v1/objects/person/records', {
          key: unrelatedKey,
          body: { values: { name: 'Still running' } },
        })
      ).status,
    ).toBe(201);
  });
  it('attaches only finalized source-owned bytes and erases staged uploads before a first revision exists', async () => {
    const h = await setup(),
      s = await h.item('not-yet-imported');
    const person = await h.app.request('/v1/objects/person/records', {
      key: h.keys.admin,
      body: { values: { name: 'Pending owner', emails: 'staged@fixture.test' } },
    });
    const bytes = Buffer.from('pending source transcript'),
      metadata = {
        name: 'staged.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceItemId: s.itemId,
      };
    expect(
      (
        await h.app.request('/v1/files/intents', {
          key: s.key,
          headers: { 'Idempotency-Key': 'unstaged' },
          body: metadata,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.request(`${h.base}/source-items/${s.itemId}/prepare`, {
          key: s.key,
          body: { participants: ['staged@fixture.test'] },
        })
      ).status,
    ).toBe(200);
    const intent = await h.app.request('/v1/files/intents', {
      key: s.key,
      headers: { 'Idempotency-Key': 'staged' },
      body: metadata,
    });
    expect(intent.status).toBe(201);
    expect(
      (
        await fetch(intent.body.upload.url, {
          method: 'PUT',
          headers: intent.body.upload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(201);
    const erased = await h.app.request(`/v1/records/${person.body.id}/forget`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(erased.status).toBe(200);
    expect(erased.body.storage.pending).toBe(1);
    const [row] = await db.owner`select state from source_items where id=${s.itemId}`;
    expect(row?.state).toBe('erased');
    expect(
      (await h.app.request(`/v1/files/${intent.body.id}/finalize`, { key: s.key, method: 'POST' }))
        .status,
    ).toBe(409);
    expect(
      await db.owner`select email from source_participants where item_id=${s.itemId}`,
    ).toHaveLength(0);
  });
  it('imports a finalized transcript by permanent field key and distinguishes a transient miss from verified deletion', async () => {
    const h = await setup(),
      s = await h.item();
    expect(
      (
        await h.app.request(`${h.base}/source-items/${s.itemId}/prepare`, {
          key: s.key,
          body: { participants: [] },
        })
      ).status,
    ).toBe(200);
    const bytes = Buffer.from('immutable evidence'),
      metadata = {
        name: 'meeting.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceItemId: s.itemId,
      };
    const intent = await h.app.request('/v1/files/intents', {
      key: s.key,
      headers: { 'Idempotency-Key': 'source-file' },
      body: metadata,
    });
    expect(intent.status).toBe(201);
    await fetch(intent.body.upload.url, {
      method: 'PUT',
      headers: intent.body.upload.headers,
      body: bytes,
    });
    expect(
      (await h.app.request(`/v1/files/${intent.body.id}/finalize`, { key: s.key, method: 'POST' }))
        .status,
    ).toBe(200);
    const [field] =
      await db.owner`select key,universal_id from fields where workspace_id=${h.workspace.id} and type='files'`;
    const imported = await h.sync(s.key, s.itemId, '1', null, {
      ...h.event('Transcript'),
      fields: { [field?.universal_id]: [intent.body.id] },
    } as ReturnType<typeof h.event>);
    expect(imported.status).toBe(200);
    expect(
      (
        await h.sync(s.key, s.itemId, '2', imported.body.revisionId, {
          ...h.event('Transcript'),
          fields: { [field?.key]: [intent.body.id], [field?.universal_id]: [intent.body.id] },
        })
      ).body.error.code,
    ).toBe('invalid_source_field');
    const download = await h.app.request(`/v1/files/${intent.body.id}/download`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(download.status).toBe(200);
    expect(await (await fetch(download.body.url)).text()).toBe(bytes.toString());
    const retryIntent = await h.app.request('/v1/files/intents', {
      key: s.key,
      headers: { 'Idempotency-Key': 'same-source-bytes' },
      body: metadata,
    });
    expect(retryIntent.status).toBe(201);
    await fetch(retryIntent.body.upload.url, {
      method: 'PUT',
      headers: retryIntent.body.upload.headers,
      body: bytes,
    });
    await h.app.request(`/v1/files/${retryIntent.body.id}/finalize`, {
      key: s.key,
      method: 'POST',
    });
    const unchanged = await h.sync(s.key, s.itemId, '2', imported.body.revisionId, {
      ...h.event('Transcript'),
      fields: { [field?.key]: [retryIntent.body.id] },
    } as ReturnType<typeof h.event>);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.unchanged).toBe(true);
    expect(unchanged.body.eventId).toBe(imported.body.eventId);
    const path = `${h.base}/source-items/${s.itemId}/unavailable`;
    expect(
      (await h.app.request(path, { key: s.key, body: { status: 'unavailable' } })).body.state,
    ).toBe('unavailable');
    expect((await h.app.request(path, { key: s.key, body: { status: 'deleted' } })).status).toBe(
      400,
    );
    expect(
      (
        await h.app.request(path, {
          key: s.key,
          body: { status: 'deleted', evidence: 'provider_event' },
        })
      ).body.state,
    ).toBe('deleted');
    expect(
      (await h.sync(s.key, s.itemId, '2', imported.body.revisionId, h.event('Recreate'))).body.error
        .code,
    ).toBe('source_retracted');
    expect(
      (await h.app.request(`/v1/events/${imported.body.eventId}`, { key: h.keys.admin })).status,
    ).toBe(200);
  });
  it('serializes a source edit against erasure and cannot leave a newly edited revision behind', async () => {
    const h = await setup('everyone'),
      s = await h.item();
    const first = await h.sync(
      s.key,
      s.itemId,
      '1',
      null,
      h.event('Before race', [{ email: 'race@fixture.test' }]),
    );
    expect(first.status).toBe(200);
    const [person] =
      await db.owner`select record_id from record_identifiers where workspace_id=${h.workspace.id} and value='race@fixture.test'`;
    const [edited, erased] = await Promise.all([
      h.sync(s.key, s.itemId, '2', first.body.revisionId, h.event('Racing fetched content')),
      h.app.request(`/v1/records/${person?.record_id}/forget`, {
        key: h.keys.admin,
        method: 'POST',
      }),
    ]);
    expect(erased.status).toBe(200);
    expect([200, 409]).toContain(edited.status);
    expect(await db.owner`select id from source_revisions where item_id=${s.itemId}`).toHaveLength(
      0,
    );
    expect(
      await db.owner`select id from records where workspace_id=${h.workspace.id} and label in ('Before race','Racing fetched content')`,
    ).toHaveLength(0);
  });
  it('keeps source suppression across reinstall and key rotation, failing closed if an old key disappears', async () => {
    const h = await setup(),
      external = 'erased-across-reinstall',
      s = await h.item(external);
    const first = await h.sync(s.key, s.itemId, '1', null);
    expect(first.status).toBe(200);
    expect(
      (
        await h.app.request(`/v1/records/${first.body.eventId}/forget`, {
          key: h.keys.admin,
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    await h.app.request(`${h.base}/uninstall`, { key: h.keys.admin, method: 'POST' });
    const [cleanup] =
      await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='uninstall' and status='queued'`;
    const cleanupRun = await h.queue.claim(h.workspace.id, cleanup?.id, 'cleanup');
    if (!cleanupRun) throw new Error('cleanup missing');
    await h.queue.complete(cleanupRun, { status: 'succeeded' });
    const input = {
      registrationId: h.manifest.universalId,
      version: h.manifest.version,
      settings: {},
    };
    const preview = await h.app.request('/v1/extensions/preview', {
      key: h.keys.admin,
      body: input,
    });
    expect(
      (
        await h.app.request('/v1/extensions', {
          key: h.keys.admin,
          body: { ...input, planDigest: preview.body.planDigest },
          headers: { 'Idempotency-Key': 'reinstall' },
        })
      ).status,
    ).toBe(201);
    const [setupJob] =
      await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='install' and status='queued'`;
    const setupRun = await h.queue.claim(h.workspace.id, setupJob?.id, 'setup-again');
    if (!setupRun) throw new Error('setup missing');
    const verified = await h.app.request(`${h.base}/source/verify`, {
      key: await h.token(setupRun),
      body: { accountId: 'provider-workspace-1', sharing: 'workspace' },
    });
    expect(verified.body.sourceAccountId).toBe(h.accountId);
    await h.queue.complete(setupRun, { status: 'succeeded' });
    const scan = await h.start(),
      oldKey = process.env.RETAINER_SUPPRESSION_KEY,
      oldPrevious = process.env.RETAINER_SUPPRESSION_PREVIOUS_KEYS;
    try {
      process.env.RETAINER_SUPPRESSION_KEY = randomBytes(32).toString('hex');
      process.env.RETAINER_SUPPRESSION_PREVIOUS_KEYS = [oldKey, oldPrevious]
        .filter(Boolean)
        .join(',');
      const response = await h.app.request(`${h.base}/source-items`, {
        key: scan.key,
        body: { sourceAccountId: h.accountId, externalId: external },
      });
      expect(response.body.error.code).toBe('source_erased');
      delete process.env.RETAINER_SUPPRESSION_PREVIOUS_KEYS;
      expect(
        (
          await h.app.request(`${h.base}/source-items`, {
            key: scan.key,
            body: { sourceAccountId: h.accountId, externalId: external },
          })
        ).status,
      ).toBe(503);
    } finally {
      if (oldKey === undefined) delete process.env.RETAINER_SUPPRESSION_KEY;
      else process.env.RETAINER_SUPPRESSION_KEY = oldKey;
      if (oldPrevious === undefined) delete process.env.RETAINER_SUPPRESSION_PREVIOUS_KEYS;
      else process.env.RETAINER_SUPPRESSION_PREVIOUS_KEYS = oldPrevious;
    }
  });
  it('uses the same item authority and revision semantics over MCP', async () => {
    const h = await setup(),
      s = await h.item(),
      client = await h.app.mcpClient(s.key);
    try {
      expect(
        (await client.call('get_source_item', { installationId: h.id, sourceItemId: s.itemId }))
          .body.externalId,
      ).toBeTruthy();
      const imported = await client.call('sync_source_event', {
        installationId: h.id,
        sourceItemId: s.itemId,
        providerRevision: '1',
        expectedRevisionId: null,
        event: h.event('MCP evidence'),
      });
      expect(imported.isError).toBe(false);
      expect(imported.body.created).toBe(true);
      expect(
        (
          await client.call('sync_source_event', {
            installationId: h.id,
            sourceItemId: randomUUID(),
            providerRevision: '1',
            expectedRevisionId: null,
            event: h.event(),
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
  it('applies the reviewed retract policy only after definitive provider deletion', async () => {
    const h = await setup('never', true, 'retract'),
      s = await h.item();
    const imported = await h.sync(s.key, s.itemId, '1', null);
    expect(imported.status).toBe(200);
    const path = `${h.base}/source-items/${s.itemId}/unavailable`;
    expect(
      (await h.app.request(path, { key: s.key, body: { status: 'unavailable' } })).body.state,
    ).toBe('unavailable');
    expect(
      (await h.app.request(`/v1/events/${imported.body.eventId}`, { key: h.keys.admin })).status,
    ).toBe(200);
    expect(
      (
        await h.app.request(path, {
          key: s.key,
          body: { status: 'deleted', evidence: 'definitive_lookup' },
        })
      ).body.state,
    ).toBe('retracted');
    expect(
      (await h.app.request(`/v1/events/${imported.body.eventId}`, { key: h.keys.admin })).status,
    ).toBe(404);
    expect(
      (await h.sync(s.key, s.itemId, '2', imported.body.revisionId, h.event('Recreate'))).body.error
        .code,
    ).toBe('source_retracted');
  });
  it('purges all managed-source stores with a workspace while preserving pending byte erasure', async () => {
    const h = await setup(),
      s = await h.item();
    expect(
      (
        await h.app.request(`${h.base}/source-items/${s.itemId}/prepare`, {
          key: s.key,
          body: { participants: ['purge@fixture.test'] },
        })
      ).status,
    ).toBe(200);
    expect((await h.sync(s.key, s.itemId, '1', null, h.event('Purge'))).status).toBe(200);
    expect(
      (
        await h.app.request('/v1/files/intents', {
          key: s.key,
          headers: { 'Idempotency-Key': 'purge' },
          body: {
            name: 'purge.txt',
            mediaType: 'text/plain',
            bytes: 5,
            sha256: 'a'.repeat(64),
            sourceItemId: s.itemId,
          },
        })
      ).status,
    ).toBe(201);
    await db.owner`delete from workspaces where id=${h.workspace.id}`;
    for (const table of [
      'source_accounts',
      'source_bindings',
      'source_items',
      'source_revisions',
      'source_receipts',
      'source_participants',
      'files',
      'extension_jobs',
    ])
      expect(
        await db.owner.unsafe(`select 1 from ${table} where workspace_id=$1`, [h.workspace.id]),
      ).toHaveLength(0);
    expect(
      await db.owner`select id from file_deletions where workspace_id=${h.workspace.id}`,
    ).toHaveLength(1);
  });
});
