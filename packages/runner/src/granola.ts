import { createHash, randomUUID } from 'node:crypto';
import { type ExecutionResult, type Invocation, isRetryLater } from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { EVENT_CONTENT_MAX, type SourceScan, sourceScanSchema } from '@retainer/shared';
import { z } from 'zod';
import {
  GRANOLA,
  GRANOLA_EVENTS,
  granolaEndpoint,
  granolaEndpointList,
  granolaList,
  type granolaNote,
} from './granola-contract.js';
import { GranolaError, GranolaProvider } from './granola-provider.js';
import { apiFetch, transient } from './outcome.js';

const DAY = 86400000,
  OVERLAP = 60000,
  // Like Twenty's Granola catch-up: every incremental scan re-lists at least two days, so a note whose
  // import failed after its scan completed is listed again; unchanged live notes enqueue nothing.
  CATCH_UP_WINDOW = 2 * DAY;
const settingsSchema = z.object({
  shareAccessibleNotes: z.literal(true),
  backfillDays: z.number().int().min(1).max(3650),
  webhooks: z.boolean(),
  createPeople: z.enum(['never', 'contacted_first', 'everyone']),
});
const progressSchema = z.strictObject({
  scanId: z.uuid(),
  epoch: z.uuid(),
  page: z.number().int().nonnegative(),
  windowStart: z.number(),
  windowEnd: z.number(),
  windowSpan: z.number().min(60000).max(DAY),
  cursor: z.string().max(8000).nullable(),
  cursorHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512),
  done: z.boolean(),
});
type Progress = z.infer<typeof progressSchema>;
const pageKey = 'granola-enumeration';

function initialProgress(scan: SourceScan): Progress {
  const start = Date.parse(scan.from),
    end = Date.parse(scan.through);
  return {
    scanId: scan.scanId,
    epoch: randomUUID(),
    page: 0,
    windowStart: start,
    windowEnd: scan.mode === 'created' ? Math.min(end, start + DAY) : end,
    windowSpan: DAY,
    cursor: null,
    cursorHashes: [],
    done: false,
  };
}
function pageChild(scan: SourceScan, key: string) {
  return { functionId: GRANOLA.scan, input: scan, dedupeKey: key };
}

/** Only explicit calendar organizer evidence qualifies as contacted_first, never speaker attribution. */
export function granolaParticipants(note: z.infer<typeof granolaNote>) {
  const people = new Map<string, { email: string; name?: string; contacted: boolean }>();
  const outbound = note.calendar_event?.organiser?.toLowerCase() === note.owner.email;
  for (const p of [note.owner, ...note.attendees, ...(note.calendar_event?.invitees ?? [])]) {
    const previous = people.get(p.email);
    people.set(p.email, {
      email: p.email,
      ...(p.name ? { name: p.name } : previous?.name ? { name: previous.name } : {}),
      contacted: outbound && p.email !== note.owner.email,
    });
  }
  if (people.size > 200) throw new GranolaError('provider_participants_exceed_limit');
  return [...people.values()];
}
async function optionalSigning(sdk: RetainerClient, id: string) {
  try {
    return await sdk.extensionSecret(id, 'signing');
  } catch (error) {
    if (error instanceof RetainerApiError && error.code === 'connection_required') return null;
    throw error;
  }
}
async function configureHooks(
  sdk: RetainerClient,
  id: string,
  provider: GranolaProvider,
  enabled: boolean,
  apiKeyRevision: number,
) {
  const local = await sdk.extensionWebhooks(id);
  if (!enabled && local.bindings.length === 0) return;
  const prepared = enabled ? await sdk.prepareExtensionWebhook(id, { route: 'notes' }) : null;
  if (prepared && new URL(prepared.url).protocol !== 'https:')
    throw new GranolaError('public_https_required');
  const urls = new Set(local.bindings.map((b) => b.url));
  if (prepared) urls.add(prepared.url);
  const remote = await provider.request('/v1/webhook-endpoints', granolaEndpointList);
  const owned = remote.webhook_endpoints.filter((e) => !e.url_redacted && urls.has(e.url));
  const signing = enabled ? await optionalSigning(sdk, id) : null;
  const savedProof = enabled ? await sdk.extensionKv(id, 'granola-hook-credential') : null;
  const proof = z
    .object({
      apiKeyRevision: z.number().int(),
      signingRevision: z.number().int(),
      subscriptionId: z.string(),
    })
    .safeParse(savedProof?.value);
  const matching = owned.filter((e) => e.url === prepared?.url);
  const existing = matching.length === 1 ? matching[0] : undefined;
  const bound = local.bindings.find((b) => b.url === prepared?.url && b.state !== 'retired');
  if (
    existing &&
    proof.success &&
    proof.data.apiKeyRevision === apiKeyRevision &&
    proof.data.signingRevision === signing?.revision &&
    proof.data.subscriptionId === existing.id &&
    bound?.subscriptionId === existing.id &&
    signing &&
    existing.enabled &&
    existing.created_by === null &&
    existing.scopes.length === 1 &&
    existing.scopes[0] === 'workspace' &&
    existing.folder_ids.length === 0 &&
    GRANOLA_EVENTS.every((event) => existing.events.includes(event))
  ) {
    for (const endpoint of owned)
      if (endpoint.id !== existing.id)
        await provider.request(`/v1/webhook-endpoints/${endpoint.id}`, z.unknown(), {
          method: 'DELETE',
          allowMissing: true,
          empty: true,
        });
    await sdk.bindExtensionWebhook(id, { route: 'notes', subscriptionId: existing.id });
    return;
  }
  // Recover a lost one-time secret by deleting/recreating only exact, unredacted own callback URLs.
  for (const endpoint of owned)
    await provider.request(`/v1/webhook-endpoints/${endpoint.id}`, z.unknown(), {
      method: 'DELETE',
      allowMissing: true,
      empty: true,
    });
  if (!prepared) {
    await sdk.retireExtensionWebhook(id, { route: 'notes' });
    return;
  }
  const created = await provider.request('/v1/webhook-endpoints', granolaEndpoint, {
    method: 'POST',
    body: { url: prepared.url, scopes: ['workspace'], events: GRANOLA_EVENTS },
  });
  if (
    created.url !== prepared.url ||
    created.url_redacted ||
    created.created_by !== null ||
    created.scopes.length !== 1 ||
    created.scopes[0] !== 'workspace' ||
    !created.enabled ||
    created.folder_ids.length !== 0 ||
    !GRANOLA_EVENTS.every((event) => created.events.includes(event)) ||
    !created.signing_secret ||
    !/^whsec_[A-Za-z0-9+/]{43}=$/.test(created.signing_secret)
  )
    throw new GranolaError('provider_workspace_key_required');
  const storedSigning = await sdk.setExtensionSecret(id, 'signing', {
    expectedRevision: signing?.revision ?? null,
    value: created.signing_secret,
  });
  await sdk.bindExtensionWebhook(id, { route: 'notes', subscriptionId: created.id });
  // A personal admin key may list workspace endpoints. Reuse is valid only for the same proven credential revision.
  await sdk.extensionCheckpoint(id, {
    children: [],
    kv: {
      key: 'granola-hook-credential',
      expectedRevision: savedProof?.revision ?? null,
      value: {
        apiKeyRevision,
        signingRevision: storedSigning.revision,
        subscriptionId: created.id,
      },
    },
  });
}
async function cleanup(sdk: RetainerClient, id: string, provider: GranolaProvider) {
  const local = await sdk.extensionWebhooks(id);
  if (local.bindings.length === 0) return;
  const urls = new Set(local.bindings.map((b) => b.url));
  const remote = await provider.request('/v1/webhook-endpoints', granolaEndpointList);
  for (const endpoint of remote.webhook_endpoints)
    if (!endpoint.url_redacted && urls.has(endpoint.url))
      await provider.request(`/v1/webhook-endpoints/${endpoint.id}`, z.unknown(), {
        method: 'DELETE',
        allowMissing: true,
        empty: true,
      });
}
async function startScan(sdk: RetainerClient, id: string, backfillDays: number, kick: string) {
  const status = await sdk.sourceSyncStatus(id);
  const through = new Date().toISOString();
  const scan: SourceScan = status.activeScan
    ? {
        scanId: status.activeScan.scanId,
        from: status.activeScan.from,
        through: status.activeScan.through,
        mode: status.activeScan.mode,
      }
    : {
        scanId: randomUUID(),
        mode: status.lastSuccessfulScanAt ? 'updated' : 'created',
        through,
        from: new Date(
          status.lastSuccessfulScanAt
            ? Date.parse(status.lastSuccessfulScanAt) - CATCH_UP_WINDOW
            : Date.parse(through) - backfillDays * DAY,
        ).toISOString(),
      };
  await sdk.beginSourceScan(id, scan);
  await sdk.extensionCheckpoint(id, {
    children: [pageChild(scan, `scan-kick:${scan.scanId}:${kick}`)],
  });
}
async function enumerate(
  sdk: RetainerClient,
  id: string,
  provider: GranolaProvider,
  scan: SourceScan,
) {
  const status = await sdk.sourceSyncStatus(id);
  // Recovery kicks already queued before a newer scan must never reopen completed bounds.
  if (
    (status.activeScan && status.activeScan.scanId !== scan.scanId) ||
    (!status.activeScan &&
      status.lastSuccessfulScanAt &&
      Date.parse(status.lastSuccessfulScanAt) >= Date.parse(scan.through))
  )
    return;
  await sdk.beginSourceScan(id, scan);
  const saved = await sdk.extensionKv(id, pageKey);
  const parsed = saved ? progressSchema.parse(saved.value) : null;
  const progress = parsed?.scanId === scan.scanId ? parsed : initialProgress(scan);
  if (progress.done) return;
  const connection = await sdk.sourceConnection(id);
  const query: Record<string, string> = {
    page_size: '30',
    created_before: new Date(progress.windowEnd + OVERLAP).toISOString(),
  };
  if (scan.mode === 'created')
    query.created_after = new Date(progress.windowStart - OVERLAP).toISOString();
  else query.updated_after = scan.from;
  if (progress.cursor) query.cursor = progress.cursor;
  let response: z.infer<typeof granolaList>;
  try {
    response = await provider.request('/v1/notes', granolaList, { query });
  } catch (error) {
    if (
      !(error instanceof GranolaError) ||
      error.code !== 'provider_invalid_request' ||
      !progress.cursor
    )
      throw error;
    if (scan.mode !== 'created' || progress.windowEnd - progress.windowStart <= 60000)
      throw new GranolaError('provider_cursor_recovery_required');
    const span = Math.max(60000, Math.floor((progress.windowEnd - progress.windowStart) / 2));
    const next = {
      ...progress,
      page: progress.page + 1,
      windowSpan: span,
      windowEnd: Math.min(Date.parse(scan.through), progress.windowStart + span),
      cursor: null,
      cursorHashes: [],
    };
    await sdk.extensionCheckpoint(id, {
      children: [pageChild(scan, `scan:${scan.scanId}:${progress.epoch}:${next.page}`)],
      kv: { key: pageKey, expectedRevision: saved?.revision ?? null, value: next },
    });
    return;
  }
  const cursorHash = response.cursor
    ? createHash('sha256').update(response.cursor).digest('hex')
    : null;
  if (
    response.hasMore &&
    (!response.cursor || !cursorHash || progress.cursorHashes.includes(cursorHash))
  )
    throw new GranolaError('provider_pagination_stalled');
  const notes = new Map(response.notes.map((n) => [n.id, n]));
  const reservation = notes.size
    ? await sdk.reserveSourceItems(id, {
        sourceAccountId: connection.sourceAccountId,
        externalIds: [...notes.keys()],
      })
    : { items: [] };
  const children: { functionId: string; input: unknown; dedupeKey: string }[] = [];
  for (const item of reservation.items) {
    if ('code' in item) continue;
    const note = notes.get(item.externalId);
    if (!note) throw new GranolaError('provider_identity_mismatch');
    if (item.state === 'live' && item.providerRevision === note.updated_at) continue;
    children.push({
      functionId: GRANOLA.sync,
      input: { sourceItemId: item.sourceItemId },
      dedupeKey: `import:${scan.scanId}:${progress.epoch}:${progress.page}:${item.sourceItemId}`,
    });
  }
  const next: Progress = {
    ...progress,
    page: progress.page + 1,
    cursor: response.hasMore ? response.cursor : null,
    cursorHashes:
      response.hasMore && cursorHash ? [...progress.cursorHashes, cursorHash].slice(-512) : [],
  };
  if (!response.hasMore) {
    if (scan.mode === 'created' && progress.windowEnd < Date.parse(scan.through)) {
      next.windowStart = progress.windowEnd;
      next.windowEnd = Math.min(Date.parse(scan.through), next.windowStart + progress.windowSpan);
    } else next.done = true;
  }
  if (!next.done)
    children.push(pageChild(scan, `scan:${scan.scanId}:${progress.epoch}:${next.page}`));
  await sdk.extensionCheckpoint(id, {
    children,
    kv: { key: pageKey, expectedRevision: saved?.revision ?? null, value: next },
    ...(next.done ? { scanComplete: { scanId: scan.scanId, through: scan.through } } : {}),
  });
}
/**
 * A transcript as plain text, one line per segment ("Dana: Let's start."),
 * so agents can read and search it. A transcript longer than an event's full
 * text may be keeps its start and says it was cut.
 */
export function granolaTranscriptText(
  transcript: z.infer<typeof granolaNote>['transcript'],
): string | undefined {
  if (!transcript?.length) return undefined;
  const text = transcript
    .map((segment) => {
      const { name, attribution, diarization_label: label } = segment.speaker;
      const speaker = name || attribution || label;
      return speaker ? `${speaker}: ${segment.text}` : segment.text;
    })
    .join('\n')
    .trim();
  if (!text) return undefined;
  const cut = '\n[Transcript cut: it is longer than Retainer keeps.]';
  return text.length > EVENT_CONTENT_MAX
    ? text.slice(0, EVENT_CONTENT_MAX - cut.length) + cut
    : text;
}

async function importNote(
  sdk: RetainerClient,
  id: string,
  provider: GranolaProvider,
  itemId: string,
  transport: typeof fetch,
  signal: AbortSignal,
  attempt: number,
  runId: string,
  approvedBindings?: Invocation['bindings'],
) {
  const item = await sdk.sourceItem(id, itemId);
  let note: z.infer<typeof granolaNote>;
  try {
    note = await provider.note(item.externalId);
  } catch (error) {
    if (error instanceof GranolaError && error.code === 'provider_note_unavailable')
      await sdk.markSourceUnavailable(id, itemId, { status: 'unavailable' });
    throw error;
  }
  if (note.deleted_at) {
    await sdk.markSourceUnavailable(id, itemId, {
      status: 'deleted',
      evidence: 'definitive_lookup',
    });
    return;
  }
  const participants = granolaParticipants(note);
  await sdk.prepareSourceItem(
    id,
    itemId,
    participants.map((p) => p.email),
  );
  const bindings = approvedBindings ?? (await sdk.extensionBindings(id));
  const meeting = bindings.bindings.meeting;
  if (meeting?.status !== 'ok') throw new GranolaError('binding_unavailable');
  const fields: Record<string, unknown> = {};
  if (meeting.fields.url) fields.url = note.web_url;
  if (meeting.fields.medium) fields.medium = 'meeting';
  if (meeting.fields.transcript && note.transcript?.length) {
    const bytes = Buffer.from(JSON.stringify(note.transcript));
    const intent = await sdk.createFileIntent(
      {
        name: 'granola-transcript.json',
        mediaType: 'application/json',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceItemId: itemId,
      },
      `granola-transcript:${itemId}:${note.updated_at}:${runId}:${attempt}`,
    );
    const uploaded = await transport(intent.upload.url, {
      method: 'PUT',
      headers: intent.upload.headers,
      body: bytes,
      signal,
      redirect: 'error',
    });
    await uploaded.body?.cancel();
    if (!uploaded.ok) throw new GranolaError('file_upload_failed', true);
    await sdk.finalizeFile(intent.id);
    fields.transcript = [intent.id];
  }
  await sdk.syncSourceEvent(id, {
    sourceItemId: itemId,
    providerRevision: note.updated_at,
    expectedRevisionId: item.revisionId,
    event: {
      binding: 'meeting',
      title: note.title ?? 'Granola meeting',
      summary: note.summary_text,
      content: granolaTranscriptText(note.transcript),
      occurredAt:
        note.calendar_event?.scheduled_start_time ??
        note.transcript?.[0]?.start_time ??
        note.created_at,
      participants,
      fields,
    },
  });
}

/** Reviewed build-time adapter; all provider I/O stays outside the API and database network. */
export async function executeGranola(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: apiFetch(transport, signal),
  });
  const id = invocation.installationId;
  try {
    const key = await sdk.extensionSecret(id, 'apiKey'),
      provider = new GranolaProvider(key.value, signal, transport);
    if (invocation.functionId === GRANOLA.cleanup) {
      await cleanup(sdk, id, provider);
      return { status: 'succeeded' };
    }
    const installation = await sdk.extension(id),
      parsedSettings = settingsSchema.safeParse(installation.settings);
    if (!parsedSettings.success) return { status: 'failed', code: 'invalid_settings' };
    const settings = parsedSettings.data;
    if (invocation.functionId === GRANOLA.setup) {
      await provider.request('/v1/notes', granolaList, { query: { page_size: '1' } });
      await sdk.verifySource(id, { sharing: 'workspace' });
      await configureHooks(sdk, id, provider, settings.webhooks, key.revision);
      await startScan(sdk, id, settings.backfillDays, invocation.runId);
    } else if (invocation.functionId === GRANOLA.schedule) {
      await startScan(sdk, id, settings.backfillDays, invocation.runId);
    } else if (invocation.functionId === GRANOLA.scan) {
      await enumerate(sdk, id, provider, sourceScanSchema.parse(invocation.input));
    } else if (invocation.functionId === GRANOLA.sync) {
      const input = z.strictObject({ sourceItemId: z.uuid() }).parse(invocation.input);
      await importNote(
        sdk,
        id,
        provider,
        input.sourceItemId,
        transport,
        signal,
        invocation.attempt,
        invocation.runId,
        invocation.bindings,
      );
    } else return { status: 'failed', code: 'function_not_bundled' };
    return { status: 'succeeded' };
  } catch (error) {
    if (error instanceof GranolaError)
      return {
        status: error.retry ? 'retry' : 'failed',
        code: error.code,
        ...(error.retry ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    if (error instanceof RetainerApiError) {
      if (['source_erased', 'source_deleted'].includes(error.code)) return { status: 'succeeded' };
      // Only conflicts a later attempt can resolve are retried; a permanent
      // one such as source_retracted fails now instead of spending retries.
      if (isRetryLater(transient(error)))
        return { status: 'retry', code: 'source_checkpoint_conflict', retryAfterSeconds: 30 };
      return { status: 'failed', code: 'source_api_rejected' };
    }
    const retryable = transient(error);
    if (isRetryLater(retryable)) throw retryable;
    return { status: 'failed', code: 'provider_invalid_response' };
  }
}
