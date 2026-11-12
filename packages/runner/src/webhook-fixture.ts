import { createHash } from 'node:crypto';
import type { ExecutionResult, Invocation } from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { BASE_EVENT_FIELD_IDS, BASE_EVENT_TYPE_IDS } from '@retainer/shared';
import { z } from 'zod';
import { retryTransient } from './outcome.js';

export const WEBHOOK_SETUP_ID = 'f98346c4-78bb-4e53-8428-75362e54e1bb';
export const WEBHOOK_SYNC_ID = 'ed65308e-33ec-4c33-a64c-2c9675c40be2';

/** Development-only source fixture: no real provider, account verification or model invocation is implied. */
export function executeWebhookFixture(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  return retryTransient(() => webhookFixture(invocation, signal, transport));
}
async function webhookFixture(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: (url, init) => transport(url, { ...init, signal }),
  });
  if (invocation.functionId === WEBHOOK_SETUP_ID) {
    if (!z.strictObject({}).safeParse(invocation.input).success)
      return { status: 'failed', code: 'invalid_input' };
    const key = await sdk.extensionSecret(invocation.installationId, 'fixtureKey');
    if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(key.value))
      return { status: 'failed', code: 'invalid_connection' };
    const prepared = await sdk.prepareExtensionWebhook(invocation.installationId, {
      route: 'notes',
    });
    await sdk.verifySource(invocation.installationId, {
      accountId: 'compose-fixture-account',
      sharing: 'workspace',
    });
    let revision: number | null = null;
    try {
      revision = (await sdk.extensionSecret(invocation.installationId, 'signing')).revision;
    } catch (error) {
      if (!(error instanceof RetainerApiError && error.code === 'connection_required')) throw error;
    }
    // This fixture's provider key is known to its disposable test producer; it is never returned by an admin read.
    await sdk.setExtensionSecret(invocation.installationId, 'signing', {
      expectedRevision: revision,
      value: key.value,
    });
    const bound = await sdk.bindExtensionWebhook(invocation.installationId, {
      route: 'notes',
      subscriptionId: 'compose-fixture-subscription',
    });
    if (bound.bindingId !== prepared.bindingId)
      return { status: 'failed', code: 'binding_changed' };
    return { status: 'succeeded' };
  }
  if (invocation.functionId !== WEBHOOK_SYNC_ID)
    return { status: 'failed', code: 'function_not_bundled' };
  const input = z.strictObject({ sourceItemId: z.uuid() }).safeParse(invocation.input);
  if (!input.success) return { status: 'failed', code: 'invalid_input' };
  const item = await sdk.sourceItem(invocation.installationId, input.data.sourceItemId);
  if (!/^compose-note-[0-9]+$/.test(item.externalId))
    return { status: 'failed', code: 'invalid_input' };
  await sdk.prepareSourceItem(invocation.installationId, item.sourceItemId, []);
  const metadata = await sdk.extension(invocation.installationId),
    fields: Record<string, unknown> = {};
  if (metadata.settings?.includeTranscript === true) {
    const schema = await sdk.schema(),
      field = schema.objects
        .flatMap((object) => object.fields)
        .find((entry) => entry.baseField === 'conversationTranscript');
    if (field?.type !== 'files') return { status: 'failed', code: 'source_schema_changed' };
    const bytes = Buffer.from(
      'A deterministic fixture transcript uploaded by an isolated source runner.',
    );
    const intent = await sdk.createFileIntent(
      {
        name: 'fixture-transcript.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceItemId: item.sourceItemId,
      },
      `fixture-transcript:${item.sourceItemId}:${invocation.attempt}`,
    );
    const uploaded = await transport(intent.upload.url, {
      method: 'PUT',
      headers: intent.upload.headers,
      body: bytes,
      signal,
    });
    if (!uploaded.ok) return { status: 'retry', code: 'file_upload_failed' };
    await sdk.finalizeFile(intent.id);
    fields[BASE_EVENT_FIELD_IDS.conversationTranscript] = [intent.id];
  }
  await sdk.syncSourceEvent(invocation.installationId, {
    sourceItemId: item.sourceItemId,
    providerRevision: '1',
    expectedRevisionId: item.revisionId,
    event: {
      type: BASE_EVENT_TYPE_IDS.conversation,
      occurredAt: '2026-11-10T12:00:00.000Z',
      title: 'Compose webhook note',
      fields,
      summary: 'Deterministic fixture evidence accepted through isolated webhook verification.',
    },
  });
  return { status: 'succeeded' };
}
