import { createHash } from 'node:crypto';
import { cappedScopes, type WorkspaceRole } from '@retainer/shared';
import { decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { isUuid } from '../db/ids.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { AppError } from '../errors.js';
import { admitInstallation } from '../extension-runtime/admission.js';

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

export type OAuthSettings = {
  issuer: string;
  resource: string;
  resourceMetadata: string;
  mode?: 'installation';
};

/** The issuer, the protected resource and its metadata URL, from the public origin. */
export function oauthSettings(publicOrigin: string): OAuthSettings {
  const origin = new URL(publicOrigin).origin;
  return {
    issuer: `${origin}${AUTH_BASE_PATH}`,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
  };
}

export const INSTALLATION_CLAIM = 'installation_id';
export const GRANT_CLAIM = 'grant_id';
export const GENERATION_CLAIM = 'grant_generation';
export function installationOAuthSettings(publicOrigin: string): OAuthSettings {
  const origin = new URL(publicOrigin).origin;
  return {
    issuer: `${origin}${AUTH_BASE_PATH}`,
    resource: `${origin}/v1`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/v1`,
    mode: 'installation',
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
      requiredClaims: [
        'sub',
        'azp',
        'exp',
        WORKSPACE_CLAIM,
        ...(settings.mode === 'installation'
          ? [INSTALLATION_CLAIM, GRANT_CLAIM, GENERATION_CLAIM]
          : []),
      ],
    }));
  } catch {
    throw refused('the access token is not valid or has expired; refresh it or connect again');
  }
  if (settings.mode === 'installation') return installationCaller(sql, claims, settings);
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
    // The app works for the person who connected it (personal memory spec 4.3).
    person: {
      id: access.user_id,
      name: access.user_name,
      check: { kind: 'oauth', subject, workspace, client },
    },
  };
}

async function installationCaller(
  sql: Sql,
  claims: Record<string, unknown>,
  settings: OAuthSettings,
): Promise<Caller> {
  const workspace = claims[WORKSPACE_CLAIM],
    installation = claims[INSTALLATION_CLAIM],
    grant = claims[GRANT_CLAIM],
    generation = claims[GENERATION_CLAIM];
  if (
    claims.aud !== settings.resource ||
    typeof claims.azp !== 'string' ||
    typeof claims.sub !== 'string' ||
    typeof workspace !== 'string' ||
    !isUuid(workspace) ||
    typeof installation !== 'string' ||
    !isUuid(installation) ||
    typeof grant !== 'string' ||
    !isUuid(grant) ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw refused('the installation access token is not valid; connect again');
  const client = claims.azp,
    subject = claims.sub;
  return inWorkspace(sql, workspace, async (tx) => {
    await lockSchemaShared(tx, workspace);
    const [row] = await tx<
      {
        registration_id: string;
        scopes: ('read' | 'write')[];
        granted_scopes: ('read' | 'write')[];
      }[]
    >`
      select i.registration_id,c.scopes,i.granted_scopes from extension_credentials c
      join extension_installations i on i.id=c.installation_id and i.workspace_id=c.workspace_id
      join oauth_grant_references r on r.credential_id=c.id and r.workspace_id=c.workspace_id and r.kind='installation'
      where c.id=${grant} and c.installation_id=${installation} and c.kind='oauth' and c.client_id=${client}
      and c.subject_id=${subject} and c.generation=${generation} and c.revoked_at is null and not c.pending and i.state='active' and i.generation=c.generation`;
    if (!row) throw refused('this installation connection was removed; connect again');
    const tokenScopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [];
    const scopes = [
      ...new Set(
        tokenScopes.filter(
          (s): s is 'read' | 'write' =>
            (s === 'read' || s === 'write') &&
            row.scopes.includes(s) &&
            row.granted_scopes.includes(s),
        ),
      ),
    ];
    const binding = {
      installationId: installation,
      registrationId: row.registration_id,
      generation,
      credentialId: grant,
      kind: 'oauth' as const,
      scopes,
    };
    const admitted = await admitInstallation(tx, workspace, binding);
    return { workspaceId: workspace, actor: admitted.actor, scopes, installation: binding };
  });
}
