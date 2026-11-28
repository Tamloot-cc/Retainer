import type { RoutineDetail } from '@retainer/shared';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../api/client.js';
import { firstMessages } from '../agent/first-message.js';
import { pausedText } from './model.js';

/**
 * The first message of an "Edit with the agent" chat (routines-in-chat spec
 * §6): the routine's ID, its description, and why it paused when it did.
 * The agent reads the rest with `get_routine`.
 */
export function editRoutineMessage(
  routine: Pick<RoutineDetail, 'id' | 'name' | 'description' | 'status' | 'pausedReason'>,
) {
  const paused = routine.status === 'paused' ? pausedText(routine) : null;
  return [
    `I'd like to change my routine "${routine.name}" (ID ${routine.id}). Read it with get_routine, then ask me what to change and draft a new version of it.`,
    `What it is meant to do: ${routine.description}`,
    ...(paused ? [`It needs attention: ${paused}`] : []),
  ].join('\n\n');
}

/**
 * Opens a web chat with the agent, plain or with a first message: the only
 * way into building a routine (chat-builds.md §2).
 */
export function useRoutineChat() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (text?: string) => {
      const chat = await api.createAgentChat(undefined, 'web');
      if (text) firstMessages.set(chat.id, text);
      return chat;
    },
    onSuccess: (chat) => void navigate({ to: '/chat/$id', params: { id: chat.id } }),
  });
}
