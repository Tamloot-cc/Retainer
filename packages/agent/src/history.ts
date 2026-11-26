import { toAISdkMessages } from '@mastra/ai-sdk/ui';
import type { MastraDBMessage } from '@mastra/core/memory';
import { isServerAddedPart } from './parts.js';
import type { MastraStoreHandle } from './store.js';

/** The UI message version the stream and the read endpoint use; pinned (spec §3.1). */
export const UI_MESSAGE_VERSION = 'v7' as const;

/** Every stored message of a session, oldest first, as Mastra saved it. */
export async function listSessionMessages(
  handle: MastraStoreHandle,
  sessionId: string,
): Promise<MastraDBMessage[]> {
  const memory = await handle.store.getStore('memory');
  if (!memory) throw new Error('the Mastra store has no memory domain');
  const { messages } = await memory.listMessages({
    threadId: sessionId,
    resourceId: sessionId,
    perPage: false,
  });
  return messages;
}

/** Drops server-added parts, and messages left with none. */
export function withoutServerAddedParts(messages: MastraDBMessage[]): MastraDBMessage[] {
  const out: MastraDBMessage[] = [];
  for (const message of messages) {
    const parts = message.content.parts.filter((part) => !isServerAddedPart(part));
    if (parts.length === 0) continue;
    out.push({ ...message, content: { ...message.content, parts } });
  }
  return out;
}

/**
 * A chat's messages for `GET /v1/agent/chats/:id`: AI SDK UI messages with
 * the server-added parts dropped (spec §3.5, §6.1).
 */
export async function readChatMessages(
  handle: MastraStoreHandle,
  sessionId: string,
): Promise<unknown[]> {
  const stored = withoutServerAddedParts(await listSessionMessages(handle, sessionId));
  return toAISdkMessages(stored, { version: UI_MESSAGE_VERSION });
}

/** A turn's ending for the chat read: the ID its person's message was saved under. */
export type TurnEnding = { messageId: string; status: string; code: string | null };

type UIMessageLike = { id: string; role: string; parts: unknown[] };

/**
 * Places each turn's ending after that turn's messages (spec §6.1), in the
 * shape the stream sends it: a `data-turn-end` part on the turn's last
 * assistant message, or on an assistant message of its own when the turn
 * saved none. A turn's messages run from its person's message to the next
 * person's message. An ending whose message was never saved (the turn died
 * first) has nowhere to go and is left out. Nothing here is stored: Mastra's
 * history stays as Mastra saved it.
 */
export function withTurnEndings<M extends UIMessageLike>(
  messages: M[],
  endings: TurnEnding[],
): M[] {
  const byMessage = new Map(endings.map((ending) => [ending.messageId, ending]));
  const out: M[] = [];
  let pending: TurnEnding | undefined;
  const flush = () => {
    if (!pending) return;
    const part = { type: 'data-turn-end', data: { status: pending.status, code: pending.code } };
    const last = out.at(-1);
    if (last && last.role === 'assistant')
      out[out.length - 1] = { ...last, parts: [...last.parts, part] };
    else out.push({ id: `turn-end-${pending.messageId}`, role: 'assistant', parts: [part] } as M);
    pending = undefined;
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      pending = byMessage.get(message.id);
    }
    out.push(message);
  }
  flush();
  return out;
}
