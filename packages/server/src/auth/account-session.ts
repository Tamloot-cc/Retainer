import { createHmac, timingSafeEqual } from 'node:crypto';
import { WORKSPACE_ROLE_SCOPES, type WorkspaceRole } from '@retainer/shared';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { isUuid } from '../db/ids.js';
import { AppError } from '../errors.js';

/**
 * Checks a person's session in accounts mode (accounts spec 4.4), without
 * Better Auth: the API never imports it. The cookie is Better Auth's signed
 * session token. The signature proves the token came from the code that
 * signed the person in, so a token read from the database alone is refused;
 * `retainer_session_access` then says whether the session is live and what
 * the person may do in the workspace the request names.
 *
 * This relies on Better Auth's cookie format, which it does not document:
 * `<token>.<base64 HMAC-SHA256 of the token>`, URL-encoded, named
 * `retainer.session_token` with a `__Secure-` prefix over HTTPS. A contract
 * test signs in through Better Auth and checks that its cookie passes here.
 */

/** Better Auth's cookie prefix for Retainer (accounts/auth.ts). */
export const ACCOUNT_COOKIE_PREFIX = 'retainer';
const SESSION_COOKIE_NAMES = [
  `__Secure-${ACCOUNT_COOKIE_PREFIX}.session_token`,
  `${ACCOUNT_COOKIE_PREFIX}.session_token`,
];

/** The header that names the workspace on a cookie request (A7). */
export const WORKSPACE_HEADER = 'X-Retainer-Workspace';

/** The signed session cookie's value, if the request has one. */
export function accountSessionCookie(c: Context): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = getCookie(c, name);
    if (value) return value;
  }
  return undefined;
}

/** The session token, if the cookie's signature is right; otherwise null. */
export function verifySessionCookie(value: string, secret: string): string | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  const signature = Buffer.from(value.slice(dot + 1), 'base64');
  const expected = createHmac('sha256', secret).update(token).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  return token;
}

/** The workspace a cookie request names; required, and an ID. */
export function requestedWorkspace(c: Context): string {
  const workspace = c.req.header(WORKSPACE_HEADER);
  if (!workspace) {
    throw new AppError(400, 'invalid_request', `send ${WORKSPACE_HEADER} with the workspace ID`);
  }
  if (!isUuid(workspace)) {
    throw new AppError(400, 'invalid_request', `${WORKSPACE_HEADER} must be a workspace ID`);
  }
  return workspace;
}

/**
 * The caller for a signed-in person in one workspace. Access is checked on
 * every request, so removing someone or changing their role applies at
 * their next request.
 */
export async function lookupAccountSession(
  sql: Sql,
  input: { cookie: string; secret: string; workspace: string },
): Promise<Caller> {
  const token = verifySessionCookie(input.cookie, input.secret);
  if (!token) throw new AppError(401, 'unauthorized', 'your session is not valid; sign in again');
  const [row] = await sql<
    {
      user_id: string;
      user_name: string;
      workspace_id: string | null;
      role: WorkspaceRole | null;
    }[]
  >`select * from retainer_session_access(${token}, ${input.workspace})`;
  if (!row) throw new AppError(401, 'unauthorized', 'your session has ended; sign in again');
  if (!row.role || !row.workspace_id) {
    // The same answer whether the workspace exists or not (4.4).
    throw new AppError(404, 'not_found', 'workspace not found');
  }
  return {
    workspaceId: row.workspace_id,
    actor: { type: 'user', id: row.user_id, name: row.user_name },
    scopes: WORKSPACE_ROLE_SCOPES[row.role],
    userId: row.user_id,
    person: { id: row.user_id, name: row.user_name, check: { kind: 'session', token } },
  };
}
