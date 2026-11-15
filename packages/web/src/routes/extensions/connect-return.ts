/**
 * Connecting a member account by OAuth (Tamloot connect spec 6.1): what the
 * starting tab saves, how the callback reads the state, and where it returns.
 */

/** What the starting tab saves; used only for the "never completed" notice. */
export type SavedAttempt = {
  workspaceId: string;
  installationId: string;
  returnPath: string;
  startedAt: string;
};

/** The notice the Connections tab shows after a return, from `?connect=`. */
export type ConnectResult = 'declined' | 'failed';

const PREFIX = 'retainer:connect:';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `v1.<workspaceId>.<installationId>.<nonce>` (spec 4.4). The IDs are routing
 * hints, not secrets; the server still checks the whole state.
 */
export function parseConnectState(
  state: string | null,
): { workspaceId: string; installationId: string } | null {
  const parts = state?.split('.') ?? [];
  const [version, workspaceId, installationId, nonce] = parts;
  if (parts.length !== 4 || version !== 'v1') return null;
  if (!workspaceId || !installationId || !nonce) return null;
  if (![workspaceId, installationId, nonce].every((part) => ID.test(part))) return null;
  return { workspaceId, installationId };
}

/** Navigation, kept in one place so tests can watch it. */
export const navigation = {
  assign: (url: string) => window.location.assign(url),
  replace: (url: string) => window.location.replace(url),
};

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveAttempt(state: string, attempt: SavedAttempt) {
  try {
    storage()?.setItem(PREFIX + state, JSON.stringify(attempt));
  } catch {
    /* Only for a notice; connecting works without it. */
  }
}

export function forgetAttempt(state: string) {
  try {
    storage()?.removeItem(PREFIX + state);
  } catch {
    /* Nothing to clean up. */
  }
}

/** The states this tab saved for one installation that no callback has removed. */
export function savedAttempts(workspaceId: string, installationId: string): string[] {
  const store = storage();
  if (!store) return [];
  const found: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const saved = JSON.parse(store.getItem(key) ?? 'null') as Partial<SavedAttempt> | null;
      if (saved?.workspaceId === workspaceId && saved.installationId === installationId)
        found.push(key.slice(PREFIX.length));
    }
  } catch {
    return found;
  }
  return found;
}

/** An installation's page, which opens on its Connections tab, inside the app's base path. */
export function connectionsHref(base: string, installationId: string, result?: ConnectResult) {
  const path = `${base.replace(/\/+$/, '')}/extensions/${encodeURIComponent(installationId)}`;
  return result ? `${path}?connect=${result}` : path;
}

/** A sign-in email the provider may prefill (spec 4.4: at most 254 characters). */
export function loginHint(email: string | undefined): string | undefined {
  return email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}
