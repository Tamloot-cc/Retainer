import { createHash } from 'node:crypto';
import { z } from 'zod';

export const gmailRegistrationId = '4c60fc8e-45f9-49c8-919e-5c05c947a9aa';
export const nangoOrigin = 'https://api.nango.dev';
const readOnlyScope = 'https://www.googleapis.com/auth/gmail.readonly';
const identityScopes = new Set(['openid', 'https://www.googleapis.com/auth/userinfo.email']);
export const nangoId = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const maxResponseBytes = 4 * 1024 * 1024;
const nangoGrant = z.object({
  connection_id: nangoId,
  provider_config_key: nangoId,
  provider: z.literal('google-mail'),
  tags: z.record(z.string(), z.string()).optional(),
  credentials: z.object({
    type: z.literal('OAUTH2'),
    raw: z.object({ scope: z.string().optional() }).optional(),
  }),
});
const apiError = z.object({
  error: z.object({
    code: z.union([z.number().int(), z.string()]).optional(),
    errors: z.array(z.object({ reason: z.string() })).default([]),
  }),
});

export class GmailProviderError extends Error {
  constructor(
    readonly code:
      | 'provider_unauthorized'
      | 'provider_forbidden'
      | 'provider_rate_limited'
      | 'provider_unavailable'
      | 'provider_invalid_request'
      | 'provider_invalid_response'
      | 'provider_content_too_large'
      | 'provider_identity_mismatch'
      | 'provider_connection_unavailable'
      | 'provider_scope_missing'
      | 'provider_scope_excessive',
    readonly retry = false,
  ) {
    super(code);
  }
}

export async function readResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  limit = maxResponseBytes,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new GmailProviderError('provider_invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > limit) throw new GmailProviderError('provider_content_too_large');
      chunks.push(chunk.value);
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof GmailProviderError) throw error;
    if (signal.aborted) throw new GmailProviderError('provider_unavailable', true);
    // Provider bodies, URLs, and schema errors may carry mailbox data.
    throw new GmailProviderError('provider_invalid_response');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type NangoGmailConfig = { apiKey: string; integrationId: string };
export type NangoGmailConnection = NangoGmailConfig & { connectionId: string };
export type ConnectAttempt = { workspaceId: string; memberId: string; attemptId: string };

export function nangoGmailAttemptTags(attempt: ConnectAttempt) {
  const tags = {
    organization_id: attempt.workspaceId,
    end_user_id: createHash('sha256')
      .update(JSON.stringify([attempt.workspaceId, attempt.memberId]))
      .digest('hex'),
    retainer_attempt_id: attempt.attemptId,
  };
  if (!Object.values(tags).every((value) => nangoId.safeParse(value).success))
    throw new GmailProviderError('provider_invalid_request');
  return tags;
}

export function assertConnectionConfig(connection: NangoGmailConnection) {
  if (
    !connection.apiKey ||
    !nangoId.safeParse(connection.integrationId).success ||
    !nangoId.safeParse(connection.connectionId).success
  )
    throw new GmailProviderError('provider_invalid_request');
}

export async function nangoRequest(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  transport: typeof fetch,
  body?: Record<string, unknown>,
) {
  try {
    return await transport(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal,
    });
  } catch {
    throw new GmailProviderError('provider_unavailable', true);
  }
}

export async function nangoFailure(
  response: Response,
  signal: AbortSignal,
  mailboxRequest = false,
) {
  const body = await readResponse(response, apiError, signal, 64 * 1024).catch(() => undefined);
  if (signal.aborted) throw new GmailProviderError('provider_unavailable', true);
  const code = body?.error.code;
  if (response.status === 404 && mailboxRequest && code === 404) return 'gmail_not_found';
  if (response.status === 404 || response.status === 424 || code === 'invalid_credentials')
    throw new GmailProviderError('provider_connection_unavailable');
  if (
    response.status === 401 ||
    (mailboxRequest &&
      response.status === 403 &&
      body?.error.errors.some(({ reason }) => reason === 'insufficientPermissions'))
  )
    throw new GmailProviderError('provider_unauthorized');
  if (
    response.status === 429 ||
    body?.error.errors.some(({ reason }) =>
      ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason),
    )
  )
    throw new GmailProviderError('provider_rate_limited', true);
  if (response.status === 403) throw new GmailProviderError('provider_forbidden');
  if (response.status >= 500) throw new GmailProviderError('provider_unavailable', true);
  throw new GmailProviderError('provider_invalid_request');
}

const connectSession = z.object({
  data: z.object({
    connect_link: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        ['connect.nango.dev', 'app.nango.dev'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port
      );
    }),
    expires_at: z.iso.datetime({ offset: true }),
  }),
});

/** Start authorization for a pending attempt created by the Retainer backend. */
export async function createNangoGmailConnectSession(
  config: NangoGmailConfig,
  attempt: ConnectAttempt,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  if (!config.apiKey || !nangoId.safeParse(config.integrationId).success)
    throw new GmailProviderError('provider_invalid_request');
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const response = await nangoRequest(
    new URL('/connect/sessions', nangoOrigin),
    { authorization: `Bearer ${config.apiKey}` },
    timeout,
    transport,
    {
      allowed_integrations: [config.integrationId],
      integrations_config_defaults: {
        [config.integrationId]: { connection_config: { oauth_scopes_override: readOnlyScope } },
      },
      tags: nangoGmailAttemptTags(attempt),
    },
  );
  if (!response.ok) await nangoFailure(response, timeout);
  const { data } = await readResponse(response, connectSession, timeout, 64 * 1024);
  return { connectLink: data.connect_link, expiresAt: data.expires_at };
}

/** Check Google's granted scopes and, at enrollment, the pending attempt's owner tags.
 * With no attempt, the caller must supply a connection already bound to its Retainer owner.
 * Use a trusted control key here. The runtime key needs no credential-read scope.
 */
export async function verifyNangoGmailGrant(
  connection: NangoGmailConnection & { attempt?: ConnectAttempt },
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  assertConnectionConfig(connection);
  const expectedTags = connection.attempt && nangoGmailAttemptTags(connection.attempt);
  const url = new URL(`/connections/${connection.connectionId}`, nangoOrigin);
  url.searchParams.set('provider_config_key', connection.integrationId);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const response = await nangoRequest(
    url,
    { authorization: `Bearer ${connection.apiKey}` },
    timeout,
    transport,
  );
  if (!response.ok) await nangoFailure(response, timeout);
  const grant = await readResponse(response, nangoGrant, timeout, 64 * 1024);
  if (
    grant.connection_id !== connection.connectionId ||
    grant.provider_config_key !== connection.integrationId ||
    (expectedTags &&
      Object.entries(expectedTags).some(([name, value]) => grant.tags?.[name] !== value))
  )
    throw new GmailProviderError('provider_identity_mismatch');
  const scopes = new Set(grant.credentials.raw?.scope?.split(/\s+/).filter(Boolean));
  if (!scopes.delete(readOnlyScope)) throw new GmailProviderError('provider_scope_missing');
  if ([...scopes].some((scope) => !identityScopes.has(scope)))
    throw new GmailProviderError('provider_scope_excessive');
}

const connectionsPage = z.object({
  connections: z.array(
    z.object({
      connection_id: nangoId,
      provider_config_key: nangoId,
      provider: z.string(),
      tags: z.record(z.string(), z.string()).nullable().optional(),
    }),
  ),
});

/** Return only connections with the exact integration and attempt tags. */
export async function listNangoGmailAttemptConnections(
  config: NangoGmailConfig,
  tags: ReturnType<typeof nangoGmailAttemptTags>,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const url = new URL('/connections', nangoOrigin);
  url.searchParams.set('limit', '3');
  for (const [name, value] of Object.entries(tags)) url.searchParams.set(`tags[${name}]`, value);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const response = await nangoRequest(
    url,
    { authorization: `Bearer ${config.apiKey}` },
    timeout,
    transport,
  );
  if (!response.ok) await nangoFailure(response, timeout);
  const result = await readResponse(response, connectionsPage, timeout, 128 * 1024);
  return result.connections
    .filter(
      (row) =>
        row.provider === 'google-mail' &&
        row.provider_config_key === config.integrationId &&
        Object.entries(tags).every(([name, value]) => row.tags?.[name] === value),
    )
    .map((row) => row.connection_id);
}

/** Only consider connections created by this pending attempt. Verify their grant separately. */
export async function findNangoGmailConnection(
  config: NangoGmailConfig,
  attempt: ConnectAttempt,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const matches = await listNangoGmailAttemptConnections(
    config,
    nangoGmailAttemptTags(attempt),
    signal,
    transport,
  );
  if (matches.length > 1) throw new GmailProviderError('provider_identity_mismatch');
  return matches[0] ?? null;
}

/** Delete this dedicated connection. A prior successful deletion can be retried. */
export async function deleteNangoGmailConnection(
  connection: NangoGmailConnection,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  assertConnectionConfig(connection);
  const url = new URL(`/connections/${connection.connectionId}`, nangoOrigin);
  url.searchParams.set('provider_config_key', connection.integrationId);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  let response: Response;
  try {
    response = await transport(url, {
      method: 'DELETE',
      redirect: 'error',
      signal: timeout,
      headers: { authorization: `Bearer ${connection.apiKey}` },
    });
  } catch {
    throw new GmailProviderError('provider_unavailable', true);
  }
  if (!response.ok && response.status !== 404) await nangoFailure(response, timeout);
  await response.body?.cancel().catch(() => {});
}
