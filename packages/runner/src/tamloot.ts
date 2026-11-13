import { createHash, randomUUID } from 'node:crypto';
import {
  type ExecutionResult,
  type Invocation,
  isRetryLater,
  type ManagedSourceTask,
} from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { BASE_EVENT_TYPE_IDS, type SourceScan, sourceScanSchema } from '@retainer/shared';
import { z } from 'zod';
import { apiFetch, transient } from './outcome.js';
import {
  TAMLOOT,
  tamlootChanges,
  tamlootHead,
  tamlootMe,
  tamlootSession,
  tamlootSessions,
  tamlootTasks,
} from './tamloot-contract.js';
import { TamlootError, TamlootProvider } from './tamloot-provider.js';

const DAY = 86400000,
  FEED = 'tamloot-feed',
  PAGE = 'tamloot-scan';
const settingsSchema = z.object({
  shareMeetings: z.literal(true),
  backfillDays: z.number().int().min(1).max(3650),
  createPeople: z.enum(['never', 'contacted_first', 'everyone']),
});
const feedSchema = z.object({ cursor: z.string().min(1).max(8000) });
const progressSchema = z.strictObject({
  scanId: z.uuid(),
  epoch: z.uuid(),
  page: z.number().int().nonnegative(),
  pass: z.number().int().min(0).max(2),
  offset: z.number().int().nonnegative(),
  localCursor: z.uuid().nullable(),
  done: z.boolean(),
});
type Child = { functionId: string; input: unknown; dedupeKey: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scanChild = (scan: SourceScan, key: string): Child => ({
  functionId: TAMLOOT.scan,
  input: scan,
  dedupeKey: key,
});
const importChild = (item: string, key: string): Child => ({
  functionId: TAMLOOT.sync,
  input: { sourceItemId: item },
  dedupeKey: `sync:${key}:${item}`,
});
function backfill(days: number): SourceScan {
  const now = Date.now();
  return {
    scanId: randomUUID(),
    mode: 'created',
    from: new Date(now - days * DAY).toISOString(),
    through: new Date(now).toISOString(),
  };
}
async function reserve(sdk: RetainerClient, id: string, externalIds: string[], key: string) {
  if (!externalIds.length) return [];
  const source = await sdk.sourceConnection(id);
  const result = await sdk.reserveSourceItems(id, {
    sourceAccountId: source.sourceAccountId,
    externalIds: [...new Set(externalIds)],
  });
  return result.items.flatMap((item) =>
    'code' in item ? [] : [importChild(item.sourceItemId, key)],
  );
}
async function start(
  sdk: RetainerClient,
  id: string,
  days: number,
  kick: string,
  created: boolean,
) {
  const status = await sdk.sourceSyncStatus(id);
  const active = status.activeScan;
  const scan: SourceScan = active
    ? { scanId: active.scanId, mode: active.mode, from: active.from, through: active.through }
    : created
      ? backfill(days)
      : {
          scanId: randomUUID(),
          mode: 'updated',
          from: status.lastSuccessfulScanAt ?? new Date(Date.now() - days * DAY).toISOString(),
          through: new Date().toISOString(),
        };
  await sdk.beginSourceScan(id, scan);
  await sdk.extensionCheckpoint(id, { children: [scanChild(scan, `kick:${scan.scanId}:${kick}`)] });
}
async function scanPage(
  sdk: RetainerClient,
  id: string,
  provider: TamlootProvider,
  scan: SourceScan,
  days: number,
) {
  const status = await sdk.sourceSyncStatus(id);
  if (status.activeScan && status.activeScan.scanId !== scan.scanId) return;
  if (
    !status.activeScan &&
    status.lastSuccessfulScanAt &&
    Date.parse(status.lastSuccessfulScanAt) >= Date.parse(scan.through)
  )
    return;
  await sdk.beginSourceScan(id, scan);
  if (scan.mode === 'updated') {
    const saved = await sdk.extensionKv(id, FEED),
      parsed = feedSchema.safeParse(saved?.value);
    if (!parsed.success) {
      const head = await provider.request('/v1/changes/head', tamlootHead),
        recovery = backfill(days);
      await sdk.extensionCheckpoint(id, {
        scanComplete: { scanId: scan.scanId, through: scan.through },
        kv: {
          key: FEED,
          expectedRevision: saved?.revision ?? null,
          value: { cursor: head.data.cursor },
        },
        children: [scanChild(recovery, `recovery:${recovery.scanId}`)],
      });
      return;
    }
    let page: z.infer<typeof tamlootChanges>;
    try {
      page = await provider.request('/v1/changes', tamlootChanges, {
        cursor: parsed.data.cursor,
        limit: '25',
      });
    } catch (error) {
      if (!(error instanceof TamlootError) || error.code !== 'provider_cursor_expired') throw error;
      const head = await provider.request('/v1/changes/head', tamlootHead),
        recovery = backfill(days);
      await sdk.extensionCheckpoint(id, {
        scanComplete: { scanId: scan.scanId, through: scan.through },
        kv: { key: FEED, expectedRevision: saved!.revision, value: { cursor: head.data.cursor } },
        children: [scanChild(recovery, `recovery:${recovery.scanId}`)],
      });
      return;
    }
    if (page.has_more && page.next_cursor === parsed.data.cursor)
      throw new TamlootError('provider_pagination_stalled');
    const sessions = [
      ...new Set(
        page.data.flatMap((c) =>
          c.entity === 'session' ? [c.entity_id] : c.session_id ? [c.session_id] : [],
        ),
      ),
    ];
    if (sessions.length > 30) throw new TamlootError('provider_invalid_response');
    const key = digest(parsed.data.cursor),
      children = await reserve(sdk, id, sessions, key);
    if (page.has_more)
      children.push(scanChild(scan, `feed:${scan.scanId}:${digest(page.next_cursor)}`));
    await sdk.extensionCheckpoint(id, {
      children,
      kv: { key: FEED, expectedRevision: saved!.revision, value: { cursor: page.next_cursor } },
      ...(!page.has_more ? { scanComplete: { scanId: scan.scanId, through: scan.through } } : {}),
    });
    return;
  }
  const saved = await sdk.extensionKv(id, PAGE),
    parsed = progressSchema.safeParse(saved?.value);
  const progress =
    parsed.success && parsed.data.scanId === scan.scanId
      ? parsed.data
      : {
          scanId: scan.scanId,
          epoch: randomUUID(),
          page: 0,
          pass: 0,
          offset: 0,
          localCursor: null,
          done: false,
        };
  if (progress.done) return;
  const next = { ...progress, page: progress.page + 1 },
    children: Child[] = [];
  if (progress.pass < 2) {
    const page = await provider.request('/v1/sessions', tamlootSessions, {
      from: scan.from,
      to: scan.through,
      limit: '25',
      offset: String(progress.offset),
    });
    children.push(
      ...(await reserve(
        sdk,
        id,
        page.data.filter((s) => s.recording_status === 'completed').map((s) => s.id),
        `${scan.scanId}:${progress.epoch}:${progress.page}`,
      )),
    );
    if (page.pagination.has_more) {
      if (page.pagination.next_offset === null || page.pagination.next_offset <= progress.offset)
        throw new TamlootError('provider_pagination_stalled');
      next.offset = page.pagination.next_offset;
    } else {
      next.pass++;
      next.offset = 0;
    }
  } else {
    const page = await sdk.sourceRecoveryItems(id, {
      limit: 25,
      ...(progress.localCursor ? { cursor: progress.localCursor } : {}),
    });
    children.push(
      ...page.items.map((item) =>
        importChild(item.sourceItemId, `${scan.scanId}:${progress.epoch}:local`),
      ),
    );
    next.localCursor = page.nextCursor;
    next.done = !page.nextCursor;
  }
  if (!next.done)
    children.push(scanChild(scan, `page:${scan.scanId}:${progress.epoch}:${next.page}`));
  await sdk.extensionCheckpoint(id, {
    children,
    kv: { key: PAGE, expectedRevision: saved?.revision ?? null, value: next },
    ...(next.done ? { scanComplete: { scanId: scan.scanId, through: scan.through } } : {}),
  });
}
export function tamlootParticipants(session: z.infer<typeof tamlootSession>['data']) {
  const people = new Map<string, { email: string; name?: string; contacted: boolean }>();
  for (const person of session.participants)
    for (const email of person.emails)
      people.set(email, { email, ...(person.name ? { name: person.name } : {}), contacted: false });
  if (people.size > 200) throw new TamlootError('provider_participants_exceed_limit');
  return [...people.values()];
}
export function tamlootSummary(notes: z.infer<typeof tamlootSession>['data']['notes']) {
  return notes
    .map((note) =>
      [note.title ? `## ${note.title}` : '', note.content ?? ''].filter(Boolean).join('\n\n'),
    )
    .filter(Boolean)
    .join('\n\n');
}
async function tasks(
  sdk: RetainerClient,
  id: string,
  item: string,
  revision: string | null,
  taskRevision: number,
  values: ManagedSourceTask[],
  complete: boolean,
) {
  const result = await sdk.syncSourceTasks(id, item, {
    expectedRevisionId: revision,
    expectedTaskRevision: taskRevision,
    tasks: values,
    complete,
  });
  if (result.hasMore)
    await sdk.extensionCheckpoint(id, {
      children: [importChild(item, `tasks:${result.checkpoint}`)],
    });
  if (result.bindingStatus === 'degraded') throw new TamlootError('source_task_schema_degraded');
  if (result.warnings.includes('source_tasks_incomplete'))
    throw new TamlootError('source_tasks_incomplete');
}
async function importSession(
  sdk: RetainerClient,
  id: string,
  provider: TamlootProvider,
  itemId: string,
) {
  const item = await sdk.sourceItem(id, itemId);
  if (['deleted', 'retracted'].includes(item.state)) {
    await tasks(sdk, id, itemId, item.revisionId, item.taskWriteRevision, [], true);
    return;
  }
  let session: z.infer<typeof tamlootSession>['data'], snapshot: z.infer<typeof tamlootTasks>;
  try {
    session = (
      await provider.request(`/v1/sessions/${z.uuid().parse(item.externalId)}`, tamlootSession)
    ).data;
    if (session.id !== item.externalId) throw new TamlootError('provider_identity_mismatch');
    if (session.recording_status !== 'completed') return;
    snapshot = await provider.request('/v1/tasks', tamlootTasks, { session_id: session.id });
  } catch (error) {
    if (!(error instanceof TamlootError) || error.code !== 'provider_session_deleted') throw error;
    await sdk.markSourceUnavailable(id, itemId, {
      status: 'deleted',
      evidence: 'definitive_lookup',
    });
    await tasks(sdk, id, itemId, item.revisionId, item.taskWriteRevision, [], true);
    return;
  }
  const participants = tamlootParticipants(session);
  await sdk.prepareSourceItem(
    id,
    itemId,
    participants.map((p) => p.email),
  );
  const result = await sdk.syncSourceEvent(id, {
    sourceItemId: itemId,
    providerRevision: session.revision,
    expectedRevisionId: item.revisionId,
    event: {
      type: BASE_EVENT_TYPE_IDS.conversation,
      occurredAt: session.session_date,
      title: session.title ?? 'Tamloot meeting',
      summary: tamlootSummary(session.notes),
      participants,
    },
  });
  if (result.stale) return;
  await tasks(
    sdk,
    id,
    itemId,
    result.revisionId,
    item.taskWriteRevision,
    snapshot.data.map((task) => ({
      externalId: task.id,
      title: task.content,
      status: task.status,
      contactEmails: task.contact_emails,
    })),
    snapshot.data.length < 500,
  );
}
export async function executeTamloot(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
      baseUrl: invocation.apiOrigin,
      apiKey: invocation.runToken,
      fetch: apiFetch(transport, signal),
    }),
    id = invocation.installationId;
  try {
    const installation = await sdk.extension(id),
      settings = settingsSchema.safeParse(installation.settings);
    if (!settings.success) return { status: 'failed', code: 'invalid_settings' };
    const key = await sdk.extensionSecret(id, 'apiKey'),
      provider = new TamlootProvider(key.value, signal, transport);
    if (invocation.functionId === TAMLOOT.connect) {
      const me = await provider.request('/v1/me', tamlootMe);
      await sdk.verifySource(id, { accountId: me.data.user_id, sharing: 'workspace' });
      const cursor = await sdk.extensionKv(id, FEED);
      if (!cursor) {
        const head = await provider.request('/v1/changes/head', tamlootHead),
          scan = backfill(settings.data.backfillDays);
        // The page job begins the scan after this atomic cursor/child checkpoint.
        // A failed checkpoint must not leave an active scan with no durable cursor.
        await sdk.extensionCheckpoint(id, {
          children: [scanChild(scan, `connect:${scan.scanId}`)],
          kv: { key: FEED, expectedRevision: null, value: { cursor: head.data.cursor } },
        });
      } else await start(sdk, id, settings.data.backfillDays, invocation.runId, true);
    } else if (invocation.functionId === TAMLOOT.poll)
      await start(sdk, id, settings.data.backfillDays, invocation.runId, false);
    else if (invocation.functionId === TAMLOOT.scan)
      await scanPage(
        sdk,
        id,
        provider,
        sourceScanSchema.parse(invocation.input),
        settings.data.backfillDays,
      );
    else if (invocation.functionId === TAMLOOT.sync)
      await importSession(
        sdk,
        id,
        provider,
        z.strictObject({ sourceItemId: z.uuid() }).parse(invocation.input).sourceItemId,
      );
    else return { status: 'failed', code: 'function_not_bundled' };
    return { status: 'succeeded' };
  } catch (error) {
    if (error instanceof TamlootError)
      return {
        status: error.retry ? 'retry' : 'failed',
        code: error.code,
        ...(error.retry ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    if (
      error instanceof RetainerApiError &&
      ['source_erased', 'source_deleted'].includes(error.code)
    )
      return { status: 'succeeded' };
    if (
      error instanceof RetainerApiError &&
      ['source_task_delete_conflict', 'source_task_conflict'].includes(error.code)
    )
      return { status: 'failed', code: error.code };
    const retryable = transient(error);
    if (isRetryLater(retryable)) throw retryable;
    return {
      status: 'failed',
      code: error instanceof RetainerApiError ? 'source_api_rejected' : 'provider_invalid_response',
    };
  }
}
