import type { ObjectView, Session } from '@retainer/shared';
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

export type Starter = {
  kind: StarterKind;
  /** The steps in the feature's words, three lines at most. */
  about: string;
  /** The one suggestion prompt, sent as the person's message. */
  prompt: string;
  placeholder: string;
};

/**
 * The starter a `/chat` search asks for, or null for the plain index. Checked
 * here, not only where the entry is shown, so a bookmarked link never offers
 * what the person or the server cannot use.
 */
export function chatStarter(
  search: ChatsSearch,
  session: Session,
  objects: readonly ObjectView[],
): Starter | null {
  if (!search.new || !session.agentAvailable || !canMutate(session)) return null;
  switch (search.new) {
    case 'dashboard':
      return {
        kind: 'dashboard',
        about:
          'Describe a dashboard and the agent drafts it from your workspace’s data. You see it live here, with real numbers. Pin it to keep it; only you see it until you share it.',
        prompt: 'Suggest a few dashboards I could build from this workspace’s data.',
        placeholder: 'Describe a dashboard…',
      };
    case 'view': {
      const object = objects.find((o) => o.nameSingular === search.object);
      if (!object) return null;
      const plural = object.labelPlural;
      return {
        kind: 'view',
        about: `Describe a view of ${plural} and the agent drafts it: which records, how they are sorted and grouped. You see the first rows here and can open it on the page. Save it to keep it; only you see it until you share it.`,
        prompt: `Suggest a few views of ${plural} I could keep.`,
        placeholder: `Describe a view of ${plural}…`,
      };
    }
    case 'routine':
      if (!session.routinesAvailable) return null;
      return {
        kind: 'routine',
        about:
          'Describe what should keep happening and the agent writes a routine and dry-runs it on recent records. You see what it would have done. Propose it to keep it; an admin approves it before anything runs.',
        prompt: 'Suggest a few routines that would save time in this workspace.',
        placeholder: 'Describe a routine…',
      };
  }
}
