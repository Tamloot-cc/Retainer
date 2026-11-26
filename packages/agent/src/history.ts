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
