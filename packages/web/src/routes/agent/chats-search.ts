import type { Session } from '@retainer/shared';
import { canMutate } from '../../api/client.js';

/** What a feature page's New entry starts in the chat (chat-builds.md §5.2). */
export type StarterKind = 'dashboard' | 'view' | 'routine';

/** The chat index's search: `/chat?new=view&object=company`. */
export type ChatsSearch = { new?: StarterKind; object?: string };

const KINDS: readonly StarterKind[] = ['dashboard', 'view', 'routine'];

export function validateChatsSearch(raw: Record<string, unknown>): ChatsSearch {
  const kind = KINDS.find((k) => k === raw.new);
  if (!kind) return {};
  return kind === 'view' && typeof raw.object === 'string' && raw.object
    ? { new: kind, object: raw.object }
    : { new: kind };
}

/**
 * Whether the person can start building this kind in the chat: the agent is on,
 * they have write, and routines are available for a routine. The entries and
 * the starter both ask it, so a link never leads to what the chat won't offer.
 */
export function canStart(kind: StarterKind, session: Session): boolean {
  return (
    session.agentAvailable === true &&
    canMutate(session) &&
    (kind !== 'routine' || session.routinesAvailable === true)
  );
}
