import { RetainerClient } from '@retainer/sdk';
import type { SchemaDescription, Scope, Session } from '@retainer/shared';
import { createContext, useContext } from 'react';
import { updatingFetch } from './maintenance.js';

async function errorCode(response: Response): Promise<unknown> {
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return (body as { error?: { code?: unknown } } | null)?.error?.code;
}
let sessionEpoch = 0;
let sessionRequests = new AbortController();
export function resetSessionTransport() {
  sessionEpoch++;
  sessionRequests.abort();
  sessionRequests = new AbortController();
}
const makeClient = (workspace?: string) =>
  new RetainerClient({
    baseUrl: window.location.origin,
    credentials: 'include',
    ...(workspace ? { workspace } : {}),
    fetch: async (input, init) => {
      const epoch = sessionEpoch;
      init = {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, sessionRequests.signal])
          : sessionRequests.signal,
      };
      let response = await updatingFetch(input, init);
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      // POST reads take a body: queries, totals and delete impact.
      const read =
        !init?.method ||
        init.method === 'GET' ||
        /\/(query|aggregate|delete-impact)$/.test(url.pathname);
      // A 404 may mean the cached schema names an object that no longer exists;
      // a deleted record is a plain answer, so it skips the schema refresh.
      if (
        response.status === 404 &&
        read &&
        url.pathname.startsWith('/v1/') &&
        url.pathname !== '/v1/schema' &&
        (await errorCode(response)) !== 'record_deleted'
      ) {
        const refreshed = await api.schema(init?.signal ?? undefined);
        if (epoch !== sessionEpoch)
          throw new DOMException('Previous session response discarded', 'AbortError');
        window.dispatchEvent(new CustomEvent('retainer:schema-refreshed', { detail: refreshed }));
        response = await updatingFetch(input, init);
      }
      if (epoch !== sessionEpoch)
        throw new DOMException('Previous session response discarded', 'AbortError');
      return response;
    },
    onUnauthorized: () => window.dispatchEvent(new Event('retainer:unauthorized')),
  });
/** The API client; in accounts mode, `openWorkspace` names the workspace it talks to. */
export let api = makeClient();
/** Accounts mode: send every request to this workspace (`X-Retainer-Workspace`). */
export function openWorkspace(id: string) {
  api = makeClient(id);
}
export const WorkspaceContext = createContext<{
  session: Session;
  schema: SchemaDescription;
} | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Missing workspace');
  return value;
}
export function canMutate(session: Session, scope: Scope = 'write') {
  return (
    session.actor.type === 'user' &&
    (session.scopes.includes('admin') || session.scopes.includes(scope))
  );
}
export function hasScope(session: Session, scope: Scope) {
  return session.scopes.includes('admin') || session.scopes.includes(scope);
}

export const AuthContext = createContext<{ session: Session; signOut: () => void } | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Missing session');
  return value;
}
