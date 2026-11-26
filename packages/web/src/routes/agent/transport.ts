import type { AgentStreamToken } from '@retainer/sdk';
import { DefaultChatTransport } from 'ai';
import { api } from '../../api/client.js';
import { type ChatMessage, chatRequestBody, messageText } from './model.js';

/**
 * Sends a chat's next message to the agent (agent spec §6.1, §7.3). Each turn
 * gets a fresh stream token from the API, then posts exactly one text part to
 * the token's stream URL: no history, IDs or options, which the runtime
 * refuses. The token is the only credential the request carries.
 */
export function chatTransport(
  chatId: string,
  token: (id: string) => Promise<AgentStreamToken> = (id) => api.agentChatToken(id),
) {
  return new DefaultChatTransport<ChatMessage>({
    prepareSendMessagesRequest: async ({ messages }) => {
      const last = messages.at(-1);
      const stream = await token(chatId);
      return {
        api: stream.streamUrl,
        headers: { authorization: `Bearer ${stream.token}` },
        credentials: 'omit',
        body: chatRequestBody(last ? messageText(last) : ''),
      };
    },
  });
}
