import type { SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { router } from '../extensions/test-router.js';
import { ChatPage, ChatsPage } from './chat.js';

vi.mock('@tanstack/react-router', async (original) =>
  (await import('../extensions/test-router.js')).mockRouter(original),
);

const STREAM_URL = 'https://agent.test/chats/chat-1/stream';

function show(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'dana', name: 'Dana' },
            agentAvailable: true,
            scopes: ['read', 'write'],
            workspace: { id: 'workspace', name: 'Acme', slug: 'acme' },
            person: true,
          } as Session,
          schema: { objects: [] } as unknown as SchemaDescription,
        }}
      >
        {element}
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

/** A UI message stream, as the agent runtime sends it (agent spec §6.1). */
function sse(chunks: unknown[]) {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

const saved = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Who is Dana?' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      { type: 'reasoning', text: 'Look her up first.', state: 'done' },
      {
        type: 'tool-search',
        toolCallId: 't1',
        state: 'output-available',
        input: { query: 'Dana' },
        output: { results: [] },
      },
      { type: 'text', text: 'Dana is the **CTO** of Acme.', state: 'done' },
    ],
  },
];

function chat(
  over: { running?: boolean; messages?: unknown[]; lastTurnStatus?: string | null } = {},
) {
  return vi.spyOn(api, 'agentChat').mockResolvedValue({
    id: 'chat-1',
    title: 'Who is Dana?',
    running: over.running ?? false,
    lastTurnStatus: over.lastTurnStatus ?? 'completed',
    messages: (over.messages ?? saved) as never,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.reset();
});

describe('ChatPage', () => {
  it('shows saved messages: the question, the reasoning collapsed, tool lines and the answer', async () => {
    router.params = { id: 'chat-1' };
    chat();
    show(<ChatPage />);
    expect(await screen.findByText('Who is Dana?', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('Thought about it')).toBeTruthy();
    expect(screen.getByText('Searched for “Dana”')).toBeTruthy();
    expect(screen.getByText('CTO').tagName).toBe('STRONG');
    // Collapsed: the reasoning text is in a closed <details>.
    const details = screen.getByText('Look her up first.').closest('details');
    expect(details?.open).toBe(false);
  });

  it('sends exactly one text part to the stream URL with a fresh token, and streams the answer', async () => {
    router.params = { id: 'chat-1' };
    chat({ messages: [] });
    const token = vi
      .spyOn(api, 'agentChatToken')
      .mockResolvedValue({ token: 'stream-token', expiresAt: '', streamUrl: STREAM_URL });
    const fetch = vi.fn(async () =>
      sse([
        { type: 'start', messageId: 'a2' },
        { type: 'start-step' },
        {
          type: 'tool-input-available',
          toolCallId: 't2',
          toolName: 'search',
          input: { query: 'Acme' },
        },
        { type: 'tool-output-available', toolCallId: 't2', output: { results: [] } },
        { type: 'text-start', id: 'x' },
        { type: 'text-delta', id: 'x', delta: 'Acme is a customer.' },
        { type: 'text-end', id: 'x' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]),
    );
    vi.stubGlobal('fetch', fetch);
    show(<ChatPage />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'Tell me about Acme{Enter}');
    expect(await screen.findByText('Acme is a customer.')).toBeTruthy();
    expect(screen.getByText('Searched for “Acme”')).toBeTruthy();
    expect(token).toHaveBeenCalledWith('chat-1');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(STREAM_URL);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer stream-token');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({
      message: { parts: [{ type: 'text', text: 'Tell me about Acme' }] },
    });
  });

  it("shows the chat's title once its first message has set it", async () => {
    router.params = { id: 'chat-1' };
    const detail = vi
      .spyOn(api, 'agentChat')
      .mockResolvedValueOnce({ id: 'chat-1', title: null, running: false, messages: [] })
      .mockResolvedValue({
        id: 'chat-1',
        title: 'Tell me about Acme',
        running: false,
        messages: [],
      });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 'stream-token',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'start', messageId: 'a2' },
          { type: 'text-start', id: 'x' },
          { type: 'text-delta', id: 'x', delta: 'Acme is a customer.' },
          { type: 'text-end', id: 'x' },
          { type: 'finish' },
        ]),
      ),
    );
    show(<ChatPage />);
    expect(await screen.findByRole('heading', { name: 'New chat' })).toBeTruthy();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'Tell me about Acme{Enter}',
    );
    expect(await screen.findByRole('heading', { name: 'Tell me about Acme' })).toBeTruthy();
    // The streamed answer stays: the refetch doesn't replace what was streamed.
    expect(screen.getByText('Acme is a customer.')).toBeTruthy();
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('says in plain words how a turn ended, and offers a new chat when this one is over', async () => {
    router.params = { id: 'chat-1' };
    chat({ messages: [] });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'start', messageId: 'a2' },
          { type: 'data-turn-end', data: { status: 'context_limit_reached', code: null } },
          { type: 'finish' },
        ]),
      ),
    );
    show(<ChatPage />);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hi{Enter}');
    expect(await screen.findByText(/too long to continue/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start a new chat' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('shows how the last turn ended after a reload, which the saved messages do not carry', async () => {
    router.params = { id: 'chat-1' };
    chat({ lastTurnStatus: 'context_limit_reached' });
    show(<ChatPage />);
    expect(await screen.findByText(/too long to continue/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start a new chat' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('after Stop, shows the saved chat and that the turn was stopped', async () => {
    router.params = { id: 'chat-1' };
    const detail = vi
      .spyOn(api, 'agentChat')
      .mockResolvedValueOnce({
        id: 'chat-1',
        title: 'Who is Dana?',
        running: false,
        lastTurnStatus: null,
        messages: [],
      })
      .mockResolvedValue({
        id: 'chat-1',
        title: 'Who is Dana?',
        running: false,
        lastTurnStatus: 'cancelled',
        messages: saved.slice(0, 1) as never,
      });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'cancelAgentChat').mockResolvedValue({ cancelled: true });
    // A stream that never ends: only Stop ends the turn on this page.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'start', messageId: 'a2' })}\n\n`,
                  ),
                );
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                );
              },
            }),
            {
              headers: {
                'content-type': 'text/event-stream',
                'x-vercel-ai-ui-message-stream': 'v1',
              },
            },
          ),
      ),
    );
    show(<ChatPage />);
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Message' }),
      'Who is Dana?{Enter}',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped.')).toBeTruthy();
    expect(screen.getByText('Who is Dana?', { selector: 'div' })).toBeTruthy();
    expect(detail.mock.calls.length).toBeGreaterThan(1);
  });

  it('explains a refused message: another turn is still running', async () => {
    router.params = { id: 'chat-1' };
    chat({ messages: [] });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'turn_running' }), { status: 409 })),
    );
    show(<ChatPage />);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hi{Enter}');
    expect(await screen.findByText(/still answering your last message/)).toBeTruthy();
  });

  it('shows a turn still running from before, and stops it', async () => {
    router.params = { id: 'chat-1' };
    chat({ running: true, messages: saved.slice(0, 1) });
    const cancel = vi.spyOn(api, 'cancelAgentChat').mockResolvedValue({ cancelled: true });
    show(<ChatPage />);
    expect(await screen.findByText('Still working on your last message…')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(cancel).toHaveBeenCalledWith('chat-1');
  });

  it('deletes the chat after asking, then goes back to the list', async () => {
    router.params = { id: 'chat-1' };
    chat();
    const remove = vi.spyOn(api, 'deleteAgentChat').mockResolvedValue(undefined);
    show(<ChatPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/chat' }));
    expect(remove).toHaveBeenCalledWith('chat-1');
  });
});

describe('ChatsPage', () => {
  it("lists the person's chats, newest first, and marks one still answering", async () => {
    vi.spyOn(api, 'agentChats').mockResolvedValue({
      chats: [
        { id: 'old', title: 'Older chat', createdAt: '2026-11-01T00:00:00Z', status: 'idle' },
        {
          id: 'new',
          title: null,
          createdAt: '2026-11-20T00:00:00Z',
          lastActiveAt: '2026-11-25T00:00:00Z',
          status: 'running',
        },
      ],
    });
    show(<ChatsPage />);
    const list = await screen.findByRole('region', { name: 'Your chats' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      expect.stringContaining('Untitled chat'),
      expect.stringContaining('Older chat'),
    ]);
    expect(within(links[0] as HTMLElement).getByText('Answering…')).toBeTruthy();
  });

  it('starts a chat from the first message and opens it', async () => {
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    const create = vi
      .spyOn(api, 'createAgentChat')
      .mockResolvedValue({ id: 'chat-9', title: null, createdAt: '2026-11-26T00:00:00Z' });
    show(<ChatsPage />);
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello{Enter}');
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/chat/$id', params: { id: 'chat-9' } }),
    );
    expect(create).toHaveBeenCalled();
  });
});
