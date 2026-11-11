import type { Actor, Session } from '@retainer/shared';
import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { AppError } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { readBody } from '../http/request.js';
import type { AppEnv } from '../http/response.js';
import { hashApiKey } from './keys.js';
export const SESSION_COOKIE = 'retainer_session';
export async function lookupKey(sql: Sql, raw: string): Promise<Caller> {
  const hash = hashApiKey(raw);
  const [key] = await sql<
    {
      workspace_id: string;
      scopes: ApiKeyScope[];
      actor: Actor;
      acts_for_user: string | null;
      acts_for_name: string | null;
    }[]
  >`select * from retainer_lookup_api_key(${hash})`;
  if (!key) throw new AppError(401, 'unauthorized', 'the API key is unknown or revoked');
  return {
    workspaceId: key.workspace_id,
    actor: key.actor,
    scopes: key.scopes,
    // A key made with "This agent works for me" (personal memory spec 4.3),
    // while its person still has a role in the workspace.
    ...(key.acts_for_user
      ? {
          person: {
            id: key.acts_for_user,
            name: key.acts_for_name ?? '',
            check: { kind: 'key' as const, hash },
          },
        }
      : {}),
  };
}
export function requireWebHeader(c: Context, publicOrigin?: string): void {
  if (c.req.header('X-Retainer-Client') !== 'web')
    throw new AppError(403, 'csrf', 'send X-Retainer-Client: web');
  // A sibling origin must not be able to use a permissive proxy CORS policy.
  const origin = c.req.header('origin');
  if (origin && origin !== (publicOrigin ?? new URL(c.req.url).origin))
    throw new AppError(403, 'csrf', 'origin must match the request origin');
}
async function presentSession(sql: Sql, caller: Caller): Promise<Session> {
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    await admitCaller(tx, caller, false, 'runtime');
    const [workspace] = await tx<
      { id: string; name: string; slug: string }[]
    >`select id, name, slug from workspaces where id = ${caller.workspaceId}`;
    if (!workspace) throw new AppError(401, 'unauthorized', 'workspace is unavailable');
    return {
      workspace,
      actor: caller.actor,
      scopes: [...caller.scopes],
      person: caller.person !== undefined,
    };
  });
}
export function sessionRoutes(app: Hono<AppEnv>, sql: Sql, publicOrigin?: string) {
  app.post('/auth/session', async (c) => {
    requireWebHeader(c, publicOrigin);
    const { key } = await readBody(c, z.strictObject({ key: z.string().min(1).max(1024) }));
    const caller = await lookupKey(sql, key);
    const result = await presentSession(sql, caller);
    const url = new URL(publicOrigin ?? c.req.url);
    setCookie(c, SESSION_COOKIE, key, {
      httpOnly: true,
      secure:
        url.protocol === 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.delete('/auth/session', (c) => {
    requireWebHeader(c, publicOrigin);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.header('Cache-Control', 'no-store');
    return c.json({ signedOut: true });
  });
}
export function meRoute(app: Hono<AppEnv>, sql: Sql) {
  app.get('/me', async (c) => c.json(await presentSession(sql, c.get('caller'))));
}
