import { createHash } from 'node:crypto';
import { cappedScopes, type WorkspaceRole } from '@retainer/shared';
import { decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';

/**
 * Checks an MCP OAuth access token (accounts spec 4.7) without Better Auth
 * and without the internet: the API never imports Better Auth, and its
 * function has no route out. Tokens are JWTs that are not stored, and a
 * valid signature says nothing about whether the person was removed since.
 * So on every request this reads the public signing keys through
 * `retainer_token_keys()`, verifies the signature, issuer, audience and
 * expiry, then asks `retainer_token_access` whether the consent still
 * exists and what the person's role is now.
 */

/** Where Better Auth runs in Retainer: the OAuth issuer is under it. */
export const AUTH_BASE_PATH = '/account/auth';

/** The access token claim naming the workspace the person picked at consent. */
export const WORKSPACE_CLAIM = 'workspace_id';

export type OAuthSettings = { issuer: string; resource: string; resourceMetadata: string };

/** The issuer, the protected resource and its metadata URL, from the public origin. */
export function oauthSettings(publicOrigin: string): OAuthSettings {
  const origin = new URL(publicOrigin).origin;
  return {
    issuer: `${origin}${AUTH_BASE_PATH}`,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** A bearer value shaped like a JWT, as opposed to a Retainer API key. */
export const looksLikeJwt = (value: string) =>
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

/** A stable actor ID for one app acting for one person (4.7). */
export function oauthActorId(clientId: string, userId: string): string {
  const client = createHash('sha256').update(clientId).digest('hex').slice(0, 12);
  return `oauth-${client}-${userId}`;
}

const refused = (message: string) => new AppError(401, 'unauthorized', message);

export async function lookupOAuthToken(
  sql: Sql,
  token: string,
  settings: OAuthSettings,
): Promise<Caller> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'EdDSA') throw new Error('unexpected algorithm');
    kid = header.kid;
  } catch {
    throw refused('the access token is not valid; connect again');
  }
  const keys = await sql<{ id: string; public_key: string; alg: string | null }[]>`
    select id, public_key, alg from retainer_token_keys()`;
  const key = keys.find((k) => k.id === kid);
  if (!key) throw refused('the access token is not valid; connect again');

  let claims: Record<string, unknown>;
  try {
    const publicKey = await importJWK(JSON.parse(key.public_key) as JWK, 'EdDSA');
    ({ payload: claims } = await jwtVerify(token, publicKey, {
      issuer: settings.issuer,
      audience: settings.resource,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'azp', 'exp', WORKSPACE_CLAIM],
    }));
  } catch {
    throw refused('the access token is not valid or has expired; refresh it or connect again');
  }
  const subject = claims.sub;
  const client = claims.azp;
  const workspace = claims[WORKSPACE_CLAIM];
  if (typeof subject !== 'string' || typeof client !== 'string' || typeof workspace !== 'string') {
    throw refused('the access token is not valid; connect again');
  }

  const [access] = await sql<
    {
      user_id: string;
      user_name: string;
      client_name: string;
      workspace_id: string;
      role: WorkspaceRole | null;
      scopes: string[];
    }[]
  >`select * from retainer_token_access(${subject}, ${workspace}, ${client})`;
  // No consent, a disabled person or app, a deleted workspace, or no role left.
  if (!access?.role) {
    throw refused('this connection was removed or no longer has access; connect again');
  }
  // A token from an earlier consent to the same app gets no more than the
  // person agreed to this time.
  const tokenScopes = (typeof claims.scope === 'string' ? claims.scope.split(' ') : []).filter(
    (scope) => access.scopes.includes(scope),
  );
  return {
    workspaceId: access.workspace_id,
    // Always an agent, so the human-only rules apply; named for both (4.7).
    actor: {
      type: 'agent',
      id: oauthActorId(client, access.user_id),
      name: `${access.client_name} for ${access.user_name}`,
    },
    scopes: cappedScopes(tokenScopes, access.role),
    connectedBy: access.user_id,
  };
}
