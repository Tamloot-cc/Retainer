import { createHash } from 'node:crypto';
import type { ExecutionResult, Invocation } from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { z } from 'zod';
import { GMAIL } from './gmail-contract.js';
import { GmailProvider, GmailProviderError } from './gmail-provider.js';
import { apiFetch, retryTransient } from './outcome.js';

const stateKey = 'gmail-history';
const targetKey = 'gmail-contact-history';
const targetState = z.object({
  target: z.object({ id: z.uuid(), pageToken: z.string().max(8000) }).nullable(),
});
const day = 86_400_000;
const settingsSchema = z.object({
  historyDays: z.number().int().min(0).max(3650),
  consentHistoryDays: z.number().int().min(0).max(3650),
  gmailConnectionStartedAt: z.iso.datetime(),
  nangoConnectionId: z.string().min(1),
});
const cursor = z.string().regex(/^\d{1,30}$/);
const time = z.number().int().nonnegative();
const stateSchema = z.object({
  start: time,
  historyId: cursor,
  pageToken: z.string().max(8000).nullable(),
  scanThrough: time.nullable(),
  lastScan: z.iso.datetime().optional(),
});
type State = z.infer<typeof stateSchema>;
const importInput = z.strictObject({ sourceItemId: z.uuid() });
type Window = { from: number; through?: number; targetId?: string };

function dedupeKey(runId: string, sourceItemId: string, window: Window) {
  // Source job payloads carry only the local item. Its durable idempotency
  // key also binds the window under which the reviewed scanner queued it.
  return `gmail:${window.from}:${window.through ?? ''}:${window.targetId ?? ''}:${createHash(
    'sha256',
  )
    .update(JSON.stringify([runId, sourceItemId]))
    .digest('hex')}`;
}

async function queueMessages(
  sdk: RetainerClient,
  invocation: Invocation,
  messageIds: string[],
  window: Window,
) {
  const children: NonNullable<Parameters<RetainerClient['extensionCheckpoint']>[1]['children']> =
    [];
  const id = invocation.installationId;
  const ids = [...new Set(messageIds)];
  if (!ids.length) return children;
  const { sourceAccountId } = await sdk.sourceConnection(id);
  for (let offset = 0; offset < ids.length; offset += 30) {
    const { items } = await sdk.reserveSourceItems(id, {
      sourceAccountId,
      externalIds: ids.slice(offset, offset + 30),
    });
    for (const item of items) {
      if (!('sourceItemId' in item)) continue;
      children.push({
        functionId: GMAIL.import,
        dedupeKey: dedupeKey(invocation.runId, item.sourceItemId, window),
        input: { sourceItemId: item.sourceItemId },
      });
    }
  }
  // One history page can contain many messages. Publish bounded batches
  // idempotently and leave the last batch for the cursor checkpoint.
  const early = children.splice(0, Math.max(0, children.length - 30));
  for (let offset = 0; offset < early.length; offset += 30)
    await sdk.extensionCheckpoint(id, { children: early.slice(offset, offset + 30) });
  return children;
}

async function scanTarget(sdk: RetainerClient, invocation: Invocation, provider: GmailProvider) {
  const id = invocation.installationId;
  const stored = await sdk.extensionKv(id, targetKey);
  const pending = stored?.value ? targetState.parse(stored.value).target : null;
  const { target } = await sdk.gmailTarget(id, pending?.id ?? null);
  if (!target && !pending) return;
  const page = target
    ? await provider.listMessages(target.from, target.through, pending?.pageToken, target.email)
    : undefined;
  const children =
    target && page
      ? await queueMessages(
          sdk,
          invocation,
          page.messages.map(({ id }) => id),
          {
            from: target.from,
            through: target.through,
            targetId: target.id,
          },
        )
      : [];
  const next =
    target && page?.nextPageToken ? { id: target.id, pageToken: page.nextPageToken } : null;
  if (target && !next) {
    // Acknowledge only after the last batch is durable.
    await sdk.extensionCheckpoint(id, { children });
    await sdk.gmailTarget(id, target.id, true);
  }
  await sdk.extensionCheckpoint(id, {
    children: next ? children : [],
    kv: { key: targetKey, expectedRevision: stored?.revision ?? null, value: { target: next } },
  });
}

export async function executeGmail(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
  now = Date.now,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: apiFetch(transport, signal),
  });
  const id = invocation.installationId;
  return retryTransient(async () => {
    try {
      if (invocation.functionId === GMAIL.disconnect) {
        await sdk.releaseGmailConnection(id);
        return { status: 'succeeded' };
      }
      const installation = await sdk.extension(id);
      const parsed = settingsSchema.safeParse(installation.settings);
      if (!parsed.success) return { status: 'failed', code: 'invalid_settings' };
      const settings = parsed.data;
      const provider = new GmailProvider(async (path, query, requestSignal) => {
        const url = new URL(`/v1/extensions/${id}/runtime/gmail/proxy`, invocation.apiOrigin);
        const response = await transport(url, {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            authorization: `Bearer ${invocation.runToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ path, query: [...query] }),
        });
        if (response.status === 409) {
          const error = z
            .object({ error: z.object({ code: z.string() }) })
            .safeParse(await response.json());
          if (error.success)
            throw new RetainerApiError(
              response.status,
              error.data.error.code,
              'Gmail message access changed',
            );
        }
        return response;
      }, signal);
      if (invocation.functionId === GMAIL.import) {
        const input = importInput.parse(invocation.input);
        const range = await sdk.gmailImportWindow(id);
        const item = await sdk.sourceItem(id, input.sourceItemId);
        const candidate = await provider.qualifiedMessage(
          item.externalId,
          async (envelope, occurredAt) =>
            (
              await sdk.prepareGmailMessage(id, {
                ...envelope,
                occurredAt,
                messageId: item.externalId,
                sourceItemId: input.sourceItemId,
              })
            ).prepared,
          range,
        );
        if (candidate.kind === 'ok')
          await sdk.appendGmailMessage(id, {
            ...candidate.value,
            sourceItemId: input.sourceItemId,
          });
        return { status: 'succeeded' };
      }

      const stored = await sdk.extensionKv(id, stateKey);
      const connecting = invocation.functionId === GMAIL.connect;
      if (!connecting && invocation.functionId !== GMAIL.poll)
        return { status: 'failed', code: 'invalid_input' };
      if (connecting)
        await sdk.verifySource(id, { accountId: settings.nangoConnectionId, sharing: 'workspace' });
      if (!stored) {
        // Privacy erasure resets managed-source cursors. Reconcile using the
        // immutable connection time and accepted limit after obtaining a new baseline.
        const { historyId } = await provider.profile();
        const through = now();
        const start = Math.max(
          0,
          Date.parse(settings.gmailConnectionStartedAt) - settings.consentHistoryDays * day,
        );
        const state: State = {
          start,
          historyId,
          scanThrough: through > start ? through : null,
          pageToken: null,
        };
        await sdk.extensionCheckpoint(id, {
          children: [],
          kv: { key: stateKey, expectedRevision: null, value: state },
        });
        return { status: 'succeeded' };
      }
      if (connecting) return { status: 'succeeded' };

      await scanTarget(sdk, invocation, provider);
      const state = stateSchema.parse(stored.value);
      const next = { ...state };
      let messageIds: string[];
      if (state.scanThrough !== null) {
        const page = await provider.listMessages(
          state.start,
          state.scanThrough,
          state.pageToken ?? undefined,
        );
        messageIds = page.messages.map((message) => message.id);
        next.pageToken = page.nextPageToken ?? null;
        if (!next.pageToken) {
          next.scanThrough = null;
          next.lastScan = new Date(state.scanThrough).toISOString();
        }
      } else {
        const history = await provider.history(state.historyId, state.pageToken ?? undefined);
        if (history.kind === 'history_expired') {
          const profile = await provider.profile();
          const through = now();
          next.historyId = profile.historyId;
          next.pageToken = null;
          next.scanThrough = through;
          messageIds = [];
        } else {
          next.pageToken = history.value.nextPageToken ?? null;
          if (!next.pageToken) {
            next.historyId = history.value.historyId;
            next.lastScan = new Date(now()).toISOString();
          }
          messageIds = history.value.candidateIds;
        }
      }
      const children = await queueMessages(sdk, invocation, messageIds, {
        from: state.start,
        ...(state.scanThrough !== null ? { through: state.scanThrough } : {}),
      });
      await sdk.extensionCheckpoint(id, {
        children,
        kv: { key: stateKey, expectedRevision: stored.revision, value: next },
      });
      return { status: 'succeeded' };
    } catch (error) {
      if (error instanceof GmailProviderError) {
        if (error.code === 'provider_connection_unavailable')
          return { status: 'failed', code: 'provider_unauthorized' };
        return { status: error.retry ? 'retry' : 'failed', code: error.code };
      }
      if (
        error instanceof RetainerApiError &&
        ['source_erased', 'source_deleted', 'source_retracted'].includes(error.code)
      )
        return { status: 'succeeded' };
      throw error;
    }
  });
}
