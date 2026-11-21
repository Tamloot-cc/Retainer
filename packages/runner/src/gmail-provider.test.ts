import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createNangoGmailConnectSession,
  GmailProvider,
  verifyNangoGmailGrant,
} from './gmail-provider.js';

const signal = new AbortController().signal;
const connection = {
  apiKey: 'nango-key',
  integrationId: 'google-mail',
  connectionId: 'verified-connection',
};
const attempt = { workspaceId: 'workspace', memberId: 'member', attemptId: 'attempt' };
const tags = {
  organization_id: 'workspace',
  end_user_id: createHash('sha256')
    .update(JSON.stringify([attempt.workspaceId, attempt.memberId]))
    .digest('hex'),
  retainer_attempt_id: 'attempt',
};
const id = '18a0';
const threadId = '18b0';
const historyId = '18446744073709551615';
const readOnly = 'https://www.googleapis.com/auth/gmail.readonly';

function respond(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
}

describe('GmailProvider', () => {
  it('reads the profile through the configured Nango mailbox proxy', async () => {
    const fetch = respond({ emailAddress: 'mailbox@example.com', historyId });
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(provider.profile()).resolves.toEqual({
      emailAddress: 'mailbox@example.com',
      historyId,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://api.nango.dev/proxy/gmail/v1/users/me/profile?fields=emailAddress%2ChistoryId',
    );
  });

  it('rounds a scan window outward and sends the original page token as data', async () => {
    const fetch = respond({ messages: [{ id, threadId }], nextPageToken: 'next+/=' });
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(
      provider.listMessages(1700000000000, 1700000002001, 'next+/=&q=bypass'),
    ).resolves.toEqual({
      messages: [{ id, threadId }],
      nextPageToken: 'next+/=',
    });
    const [target, init] = fetch.mock.calls[0] ?? [];
    const url = new URL(String(target));
    expect(url.pathname).toBe('/proxy/gmail/v1/users/me/messages');
    expect(url.searchParams.getAll('q')).toEqual(['after:1699999999 before:1700000003']);
    expect(url.searchParams.get('pageToken')).toBe('next+/=&q=bypass');
    expect(url.searchParams.get('includeSpamTrash')).toBe('false');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: 'Bearer nango-key',
        'provider-config-key': 'google-mail',
        'connection-id': 'verified-connection',
      },
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(provider.listMessages(0, 2000)).resolves.toEqual({ messages: [] });
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('q')).toBe('before:2');
    await expect(provider.listMessages(1, 1)).rejects.toMatchObject({
      code: 'provider_invalid_request',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads only selected message headers and strips unexpected content', async () => {
    const headers = [
      { name: 'from', value: 'Dana <dana@example.com>' },
      { name: 'To', value: 'mailbox@example.com' },
    ];
    const fetch = respond({
      id,
      threadId,
      internalDate: '1700000000001',
      labelIds: ['DRAFT'],
      snippet: 'private body',
      payload: {
        headers: [...headers, { name: 'Bcc', value: 'ignored@example.com' }],
        body: { data: 'private attachment' },
      },
    });
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(provider.metadata(id)).resolves.toEqual({
      kind: 'ok',
      value: {
        id,
        threadId,
        internalDate: 1700000000001,
        labelIds: ['DRAFT'],
        payload: { headers },
      },
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/proxy/gmail/v1/users/me/messages/${id}`);
    expect(url.searchParams.get('format')).toBe('METADATA');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual([
      'From',
      'To',
      'Subject',
      'Date',
      'Message-ID',
    ]);
    await expect(provider.metadata('../profile')).rejects.toMatchObject({
      code: 'provider_invalid_request',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.metadata('different-id')).rejects.toMatchObject({
      code: 'provider_identity_mismatch',
    });
  });

  it('checks the parsed From and To before fetching a body and excludes quotes and attachments', async () => {
    const headers = [
      { name: 'From', value: '"Dana, Sales" <DANA@example.com>' },
      { name: 'To', value: 'Team: billing@example.com, support@example.com;' },
      { name: 'Cc', value: 'cc@example.com' },
      { name: 'Subject', value: 'Renewal' },
      { name: 'Date', value: 'Fri, 12 Nov 2021 10:00:00 +0000' },
      { name: 'Message-ID', value: '<message@example.com>' },
    ];
    const metadata = { id, threadId, internalDate: '1700000000001', payload: { headers } };
    const fetch = respond(metadata);
    const provider = GmailProvider.forNango(connection, signal, fetch);
    const qualifies = vi.fn(async () => false);
    await expect(provider.qualifiedMessage(id, qualifies)).resolves.toEqual({ kind: 'ineligible' });
    expect(qualifies).toHaveBeenCalledWith(
      {
        from: ['dana@example.com'],
        to: ['billing@example.com', 'support@example.com'],
      },
      '2023-11-14T22:13:20.001Z',
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    qualifies.mockResolvedValueOnce(true);
    fetch.mockResolvedValueOnce(Response.json(metadata));
    const part = (mimeType: string, value: string) => ({
      mimeType,
      body: { data: Buffer.from(value).toString('base64url') },
    });
    fetch.mockResolvedValueOnce(
      Response.json({
        ...metadata,
        payload: {
          ...metadata.payload,
          mimeType: 'multipart/mixed',
          parts: [
            part(
              'text/html',
              '<p>My &amp; your update</p><img src="https://example.com/pixel"><blockquote>Previous private email</blockquote>',
            ),
            { ...part('text/plain', 'Private attachment'), filename: 'private.txt' },
            { mimeType: 'message/rfc822', parts: [part('text/plain', 'Attached forwarded email')] },
          ],
        },
      }),
    );
    await expect(provider.qualifiedMessage(id, qualifies)).resolves.toEqual({
      kind: 'ok',
      value: {
        body: 'My & your update',
        messageId: id,
        threadId,
        from: ['dana@example.com'],
        to: ['billing@example.com', 'support@example.com'],
        subject: 'Renewal',
        occurredAt: '2023-11-14T22:13:20.001Z',
        originalDate: '2021-11-12T10:00:00.000Z',
        rfcMessageId: '<message@example.com>',
      },
    });
  });

  it('only checks eligible in-window messages and rejects an envelope changed by the full read', async () => {
    const headers = [{ name: 'From', value: 'dana@example.com' }];
    const metadata = { id, threadId, internalDate: '1700000000001', payload: { headers } };
    const fetch = respond(metadata);
    const provider = GmailProvider.forNango(connection, signal, fetch);
    const qualifies = vi.fn(async () => true);
    await expect(
      provider.qualifiedMessage(id, qualifies, { from: 1700000000002 }),
    ).resolves.toEqual({ kind: 'ineligible' });
    fetch.mockResolvedValueOnce(Response.json({ ...metadata, labelIds: ['DRAFT'] }));
    await expect(provider.qualifiedMessage(id, qualifies)).resolves.toEqual({ kind: 'ineligible' });
    fetch.mockResolvedValueOnce(
      Response.json({
        ...metadata,
        payload: { headers: [{ name: 'Cc', value: 'dana@example.com' }] },
      }),
    );
    await expect(provider.qualifiedMessage(id, qualifies)).resolves.toEqual({ kind: 'ineligible' });
    expect(qualifies).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json(metadata));
    fetch.mockResolvedValueOnce(
      Response.json({
        ...metadata,
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'other@example.com' }],
        },
      }),
    );
    await expect(provider.qualifiedMessage(id, qualifies)).rejects.toThrow(
      /^provider_identity_mismatch$/,
    );
  });

  it('keeps history IDs as strings and deduplicates changed message candidates', async () => {
    const nextHistory = '18446744073709551616';
    const fetch = respond({
      historyId: nextHistory,
      nextPageToken: 'next',
      history: [
        { messagesAdded: [{ message: { id } }], labelsAdded: [{ message: { id } }] },
        {
          labelsRemoved: [{ message: { id: '18a1' } }],
          messagesDeleted: [{ message: { id: '18a2' } }],
        },
      ],
    });
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(provider.history(historyId, 'current')).resolves.toEqual({
      kind: 'ok',
      value: { historyId: nextHistory, nextPageToken: 'next', candidateIds: [id, '18a1'] },
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('startHistoryId')).toBe(historyId);
    expect(url.searchParams.get('pageToken')).toBe('current');
    fetch.mockResolvedValueOnce(Response.json({ historyId: nextHistory }));
    await expect(provider.history(nextHistory)).resolves.toEqual({
      kind: 'ok',
      value: { historyId: nextHistory, nextPageToken: undefined, candidateIds: [] },
    });
  });

  it('distinguishes an expired cursor from a missing message and permission errors', async () => {
    const fetch = respond({ error: { code: 404 } }, 404);
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(provider.history(historyId)).resolves.toEqual({ kind: 'history_expired' });
    await expect(provider.metadata(id)).resolves.toEqual({ kind: 'message_unavailable' });
    fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'connection_not_found' } }, { status: 404 }),
    );
    await expect(provider.history(historyId)).rejects.toThrow(/^provider_connection_unavailable$/);
    fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'invalid_credentials' } }, { status: 424 }),
    );
    await expect(provider.metadata(id)).rejects.toThrow(/^provider_connection_unavailable$/);
    fetch.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await expect(provider.history(historyId)).rejects.toMatchObject({
      code: 'provider_unauthorized',
    });
    fetch.mockResolvedValueOnce(
      Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 }),
    );
    await expect(provider.history(historyId)).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retry: true,
    });
    fetch.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(provider.profile()).rejects.toMatchObject({
      code: 'provider_forbidden',
      retry: false,
    });
  });

  it('caps response reads and keeps invalid response details out of diagnostics', async () => {
    const fetch = respond({ emailAddress: 'private@example.com', historyId: 'secret-invalid-id' });
    const provider = GmailProvider.forNango(connection, signal, fetch);
    await expect(provider.profile()).rejects.toThrow(/^provider_invalid_response$/);
    fetch.mockResolvedValueOnce(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(provider.profile()).rejects.toThrow(/^provider_content_too_large$/);
  });
});

describe('createNangoGmailConnectSession', () => {
  it('restricts the link to the configured integration and tags the pending attempt', async () => {
    const connectLink = 'https://connect.nango.dev/session';
    const expiresAt = '2026-11-20T12:00:00.000Z';
    const sessionToken = 'connect-token';
    const fetch = respond(
      { data: { token: sessionToken, connect_link: connectLink, expires_at: expiresAt } },
      201,
    );
    await expect(
      createNangoGmailConnectSession(connection, attempt, signal, fetch),
    ).resolves.toEqual({
      connectLink,
      sessionToken,
      integrationId: connection.integrationId,
      expiresAt,
    });
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.nango.dev/connect/sessions');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(request?.body))).toEqual({
      allowed_integrations: ['google-mail'],
      integrations_config_defaults: {
        'google-mail': {
          connection_config: {
            oauth_scopes_override: 'https://www.googleapis.com/auth/gmail.readonly',
          },
        },
      },
      tags,
    });
    fetch.mockResolvedValueOnce(
      Response.json({
        data: {
          token: sessionToken,
          connect_link: 'https://connect.nango.dev.example.org/session',
          expires_at: expiresAt,
        },
      }),
    );
    await expect(
      createNangoGmailConnectSession(connection, attempt, signal, fetch),
    ).rejects.toThrow(/^provider_invalid_response$/);
  });
});

describe('verifyNangoGmailGrant', () => {
  const response = (scope?: string) => ({
    connection_id: connection.connectionId,
    provider_config_key: connection.integrationId,
    provider: 'google-mail',
    credentials: { type: 'OAUTH2', raw: { scope }, access_token: 'google-secret' },
  });

  it('verifies the actual provider grant and returns no credential data', async () => {
    const fetch = respond(response(readOnly));
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://api.nango.dev/connections/verified-connection?provider_config_key=google-mail',
    );
    fetch.mockResolvedValueOnce(Response.json(response(`openid ${readOnly}`)));
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).resolves.toBeUndefined();
  });

  it('refuses an unverified grant, a broader grant, or a different connection', async () => {
    const fetch = respond(response());
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).rejects.toThrow(
      /^provider_scope_missing$/,
    );
    fetch.mockResolvedValueOnce(Response.json(response('https://mail.google.com/')));
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).rejects.toThrow(
      /^provider_scope_missing$/,
    );
    fetch.mockResolvedValueOnce(
      Response.json(response(`${readOnly} https://www.googleapis.com/auth/gmail.modify`)),
    );
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).rejects.toThrow(
      /^provider_scope_excessive$/,
    );
    fetch.mockResolvedValueOnce(Response.json({ ...response(readOnly), connection_id: 'other' }));
    await expect(verifyNangoGmailGrant(connection, signal, fetch)).rejects.toThrow(
      /^provider_identity_mismatch$/,
    );
  });

  it('binds an enrollment to the exact workspace, member and pending attempt', async () => {
    const fetch = respond({ ...response(readOnly), tags });
    await expect(
      verifyNangoGmailGrant({ ...connection, attempt }, signal, fetch),
    ).resolves.toBeUndefined();
    for (const wrongTags of [
      { ...tags, organization_id: 'another-workspace' },
      { ...tags, end_user_id: 'another-member' },
      { ...tags, retainer_attempt_id: 'another-attempt' },
      undefined,
    ]) {
      fetch.mockResolvedValueOnce(Response.json({ ...response(readOnly), tags: wrongTags }));
      await expect(
        verifyNangoGmailGrant({ ...connection, attempt }, signal, fetch),
      ).rejects.toThrow(/^provider_identity_mismatch$/);
    }
  });

  it('rejects malformed identifiers before sending a request', async () => {
    const fetch = respond({});
    await expect(
      verifyNangoGmailGrant({ ...connection, connectionId: '../profile' }, signal, fetch),
    ).rejects.toThrow(/^provider_invalid_request$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
