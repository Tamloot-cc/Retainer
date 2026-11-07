import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { ORIGIN } from './accounts.js';

/**
 * An MCP client connecting over OAuth (accounts spec 4.7, 8: Agent), the way
 * Claude's web app does, against the in-process control and api apps. No
 * internet: client metadata documents come from `CLIENT_DOCUMENTS`.
 */

/** Claude's client metadata document, as claude.ai served it on November 7, 2026. */
export const CLAUDE_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
export const CLIENT_DOCUMENTS: Record<string, unknown> = {
  [CLAUDE_CLIENT_ID]: {
    client_id: CLAUDE_CLIENT_ID,
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: [CLAUDE_REDIRECT],
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
};

/** Stands in for the network: serves the documents above, nothing else. */
export const fetchClientMetadata = async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const document = CLIENT_DOCUMENTS[url];
  return document
    ? new Response(JSON.stringify(document), {
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
      })
    : new Response('not found', { status: 404 });
};

export type Tokens = { access_token: string; refresh_token?: string; scope?: string };

export type OAuthFlow = {
  /** The consent page's URL, signed by Better Auth. */
  consentUrl: URL;
  verifier: string;
  clientId: string;
  redirectUri: string;
};

/**
 * Starts an authorization as a client would, with the person's session
 * cookie (their own page continuing it), and returns where Better Auth sent
 * the browser: the consent page.
 */
export async function authorize(
  accounts: Hono,
  input: { cookie: string; clientId?: string; redirectUri?: string; scope?: string },
): Promise<OAuthFlow> {
  const clientId = input.clientId ?? CLAUDE_CLIENT_ID;
  const redirectUri = input.redirectUri ?? CLAUDE_REDIRECT;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
    ...(input.scope ? { scope: input.scope } : {}),
  });
  const res = await accounts.request(`${ORIGIN}/account/auth/oauth2/authorize?${query}`, {
    headers: { cookie: input.cookie },
  });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) {
    throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
  }
  return { consentUrl: new URL(location, ORIGIN), verifier, clientId, redirectUri };
}

/** The consent page's request: allow (or deny) for one workspace. */
export async function consent(
  accounts: Hono,
  flow: OAuthFlow,
  input: { cookie: string; workspaceId?: string; accept?: boolean },
): Promise<Response> {
  return accounts.request(`${ORIGIN}/account/oauth/consent`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-retainer-client': 'web',
      'content-type': 'application/json',
      cookie: input.cookie,
    },
    body: JSON.stringify({
      oauth_query: flow.consentUrl.search.slice(1),
      accept: input.accept ?? true,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }),
  });
}

/** The client's back-channel request for tokens. */
export async function token(accounts: Hono, body: Record<string, string>): Promise<Response> {
  return accounts.request(`${ORIGIN}/account/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

/** Authorizes, consents for `workspaceId` and exchanges the code: a connected app. */
export async function connect(
  accounts: Hono,
  input: {
    cookie: string;
    workspaceId: string;
    scope?: string;
    clientId?: string;
    redirectUri?: string;
  },
): Promise<Tokens> {
  const flow = await authorize(accounts, input);
  const res = await consent(accounts, flow, input);
  if (!res.ok) throw new Error(`consent answered ${res.status}: ${await res.text()}`);
  const { url } = (await res.json()) as { url: string };
  const code = new URL(url).searchParams.get('code');
  if (!code) throw new Error(`consent sent no code: ${url}`);
  const exchanged = await token(accounts, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: `${ORIGIN}/mcp`,
  });
  if (!exchanged.ok)
    throw new Error(`token answered ${exchanged.status}: ${await exchanged.text()}`);
  return (await exchanged.json()) as Tokens;
}

/** A JSON-RPC call to /mcp with a bearer token. */
export async function mcpCall(
  api: { request: (url: string, init: RequestInit) => Response | Promise<Response> },
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  return api.request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
