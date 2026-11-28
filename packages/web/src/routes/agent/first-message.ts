import { api } from '../../api/client.js';

// The composer or a feature can hand an initial message to a newly created chat.
export const firstMessages = new Map<string, string>();

/** Creates a web chat with the agent, with the message it starts with, if any. */
export async function newChat(text?: string) {
  const chat = await api.createAgentChat(undefined, 'web');
  if (text) firstMessages.set(chat.id, text);
  return chat;
}
