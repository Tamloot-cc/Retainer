export {
  createNangoGmailConnectSession,
  GmailProviderError,
  verifyNangoGmailGrant,
} from '@retainer/extension/nango-gmail';

import {
  assertConnectionConfig,
  GmailProviderError,
  type NangoGmailConnection,
  nangoFailure,
  nangoOrigin,
  nangoRequest,
  readResponse,
} from '@retainer/extension/nango-gmail';
import { EVENT_CONTENT_MAX } from '@retainer/shared';
import { z } from 'zod';
import {
  excludedGmailMessage,
  type GmailEnvelope,
  gmailEnvelope,
  gmailMessageDetails,
  gmailMessagePart,
  gmailMessageText,
} from './gmail-message.js';

const pageSize = '30';
const headerNames = ['From', 'To', 'Subject', 'Date', 'Message-ID'];
const messageId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const historyId = z.string().regex(/^\d{1,30}$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

const messageRef = z.object({ id: messageId, threadId: messageId });
const listPage = z.object({
  messages: z.array(messageRef).default([]),
  nextPageToken: z.string().min(1).optional(),
});
const historyChange = z.object({ message: z.object({ id: messageId }) });
const historyPage = z.object({
  historyId,
  nextPageToken: z.string().min(1).optional(),
  history: z
    .array(
      z.object({
        messagesAdded: z.array(historyChange).default([]),
        labelsAdded: z.array(historyChange).default([]),
        labelsRemoved: z.array(historyChange).default([]),
      }),
    )
    .default([]),
});
const profile = z.object({ emailAddress: z.email(), historyId });
const messageMetadata = messageRef.extend({
  internalDate: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .pipe(timestamp),
  labelIds: z.array(z.string()).default([]),
  payload: z.object({
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .transform((headers) =>
        headers.filter((header) =>
          headerNames.some((name) => name.toLowerCase() === header.name.toLowerCase()),
        ),
      ),
  }),
});

type GmailRead = (path: string, query: URLSearchParams, signal: AbortSignal) => Promise<Response>;

/** Read-only Gmail requests. The reader controls which mailbox credential is used. */
export class GmailProvider {
  constructor(
    private readonly read: GmailRead,
    private readonly signal: AbortSignal,
  ) {}

  static forNango(
    connection: NangoGmailConnection,
    signal: AbortSignal,
    transport: typeof fetch = fetch,
  ) {
    assertConnectionConfig(connection);
    return new GmailProvider((path, query, requestSignal) => {
      const url = new URL(`/proxy/gmail/v1/users/me/${path}`, nangoOrigin);
      url.search = query.toString();
      return nangoRequest(
        url,
        {
          authorization: `Bearer ${connection.apiKey}`,
          'provider-config-key': connection.integrationId,
          'connection-id': connection.connectionId,
        },
        requestSignal,
        transport,
      );
    }, signal);
  }

  private async request<T, Missing = never>(
    path: string,
    schema: z.ZodType<T>,
    query: URLSearchParams,
    options: { onMissing?: () => Missing; onEmpty?: () => T } = {},
  ): Promise<T | Missing> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20000)]);
    const response = await this.read(path, query, signal);
    if (response.status === 204 && options.onEmpty) return options.onEmpty();
    if (response.ok) return readResponse(response, schema, signal);
    await nangoFailure(response, signal, true);
    if (options.onMissing) return options.onMissing();
    throw new GmailProviderError('provider_invalid_request');
  }

  profile() {
    return this.request(
      'profile',
      profile,
      new URLSearchParams({ fields: 'emailAddress,historyId' }),
    );
  }

  /** Candidate window [from, through). Apply exact bounds after fetching metadata. */
  async listMessages(from: number, through: number, pageToken?: string, targetEmail?: string) {
    if (
      !timestamp.safeParse(from).success ||
      !timestamp.safeParse(through).success ||
      from >= through
    )
      throw new GmailProviderError('provider_invalid_request');
    const before = `before:${Math.ceil(through / 1000)}`;
    const window = from < 1000 ? before : `after:${Math.floor(from / 1000) - 1} ${before}`;
    const target =
      targetEmail && /^[\w.+-]+@[\w.-]+$/.test(targetEmail)
        ? ` {from:${targetEmail} to:${targetEmail}}`
        : '';
    const query = new URLSearchParams({
      q: window + target,
      maxResults: pageSize,
      includeSpamTrash: 'false',
      fields: 'messages(id,threadId),nextPageToken',
    });
    if (pageToken) query.set('pageToken', pageToken);
    // Nango can represent Gmail's empty field-filtered list as a bodyless 204.
    return this.request('messages', listPage, query, { onEmpty: () => ({ messages: [] }) });
  }

  async history(startHistoryId: string, pageToken?: string) {
    if (!historyId.safeParse(startHistoryId).success)
      throw new GmailProviderError('provider_invalid_request');
    const query = new URLSearchParams({
      startHistoryId,
      maxResults: pageSize,
      fields:
        'historyId,nextPageToken,history(messagesAdded/message/id,labelsAdded/message/id,labelsRemoved/message/id)',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await this.request('history', historyPage, query, { onMissing: () => null });
    if (!result) return { kind: 'history_expired' as const };
    const candidateIds = new Set<string>();
    for (const change of result.history) {
      for (const { message } of [
        ...change.messagesAdded,
        ...change.labelsAdded,
        ...change.labelsRemoved,
      ])
        candidateIds.add(message.id);
    }
    return {
      kind: 'ok' as const,
      value: {
        historyId: result.historyId,
        nextPageToken: result.nextPageToken,
        candidateIds: [...candidateIds],
      },
    };
  }

  /** A qualifying message is fetched independently, with its envelope checked again after the full read. */
  async qualifiedMessage(
    id: string,
    qualifies: (envelope: GmailEnvelope, occurredAt: string) => Promise<boolean>,
    range?: { from: number; through?: number },
  ) {
    const metadata = await this.metadata(id);
    if (metadata.kind !== 'ok') return metadata;
    const first = metadata.value;
    if (
      excludedGmailMessage(first.labelIds) ||
      (range &&
        (first.internalDate < range.from ||
          (range.through !== undefined && first.internalDate >= range.through)))
    )
      return { kind: 'ineligible' as const };

    const envelope = gmailEnvelope(first.payload.headers);
    if (
      (!envelope.from.length && !envelope.to.length) ||
      !(await qualifies(envelope, new Date(first.internalDate).toISOString()))
    )
      return { kind: 'ineligible' as const };

    const full = await this.request(
      `messages/${id}`,
      messageMetadata.extend({ payload: gmailMessagePart }),
      new URLSearchParams({ format: 'FULL', fields: 'id,threadId,labelIds,internalDate,payload' }),
      { onMissing: () => null },
    );
    if (!full) return { kind: 'message_unavailable' as const };
    if (
      full.id !== id ||
      full.threadId !== first.threadId ||
      full.internalDate !== first.internalDate ||
      JSON.stringify(gmailEnvelope(full.payload.headers ?? [])) !== JSON.stringify(envelope)
    )
      throw new GmailProviderError('provider_identity_mismatch');
    if (excludedGmailMessage(full.labelIds)) return { kind: 'ineligible' as const };
    const body = gmailMessageText(full.payload);
    if (!body) return { kind: 'no_text' as const };
    if (body.length > EVENT_CONTENT_MAX) throw new GmailProviderError('provider_content_too_large');
    return {
      kind: 'ok' as const,
      value: {
        ...envelope,
        ...gmailMessageDetails(first.payload.headers),
        messageId: id,
        threadId: first.threadId,
        occurredAt: new Date(first.internalDate).toISOString(),
        body,
      },
    };
  }

  async metadata(id: string) {
    if (!messageId.safeParse(id).success) throw new GmailProviderError('provider_invalid_request');
    const query = new URLSearchParams({
      format: 'METADATA',
      fields: 'id,threadId,labelIds,internalDate,payload/headers(name,value)',
    });
    for (const name of headerNames) query.append('metadataHeaders', name);
    const result = await this.request(`messages/${id}`, messageMetadata, query, {
      onMissing: () => null,
    });
    if (!result) return { kind: 'message_unavailable' as const };
    if (result.id !== id) throw new GmailProviderError('provider_identity_mismatch');
    return { kind: 'ok' as const, value: result };
  }
}
