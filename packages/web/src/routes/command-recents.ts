import type { Session } from '@retainer/shared';
import { useEffect } from 'react';
import { useWorkspace } from '../api/client.js';

// Store identifiers only, in this tab. Labels and access are checked again when opened.
export type RecentCommand = { kind: 'record'; id: string } | { kind: 'object'; id: string };
export function recentCommandsKey(session: Session) {
  return `retainer:command:recent:${JSON.stringify([session.workspace.id, session.actor.type, session.actor.id])}`;
}
export function readRecentCommands(key: string): RecentCommand[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (v): v is RecentCommand =>
          !!v && (v.kind === 'record' || v.kind === 'object') && typeof v.id === 'string',
      )
      .slice(0, 6);
  } catch {
    return [];
  }
}
export function rememberCommand(key: string, item: RecentCommand) {
  try {
    const previous = readRecentCommands(key).filter(
      (v) => v.kind !== item.kind || v.id !== item.id,
    );
    sessionStorage.setItem(key, JSON.stringify([item, ...previous].slice(0, 6)));
  } catch {
    // History is optional when browser storage is unavailable.
  }
}
export function useRememberCommand(kind: RecentCommand['kind'], id: string) {
  const { session } = useWorkspace();
  const key = recentCommandsKey(session);
  useEffect(() => {
    rememberCommand(key, { kind, id });
  }, [key, kind, id]);
}
