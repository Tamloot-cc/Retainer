import type { SchemaDescription, Session } from '@retainer/shared';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { router } from '../extensions/test-router.js';
import { ChatPage, ChatsPage } from './chat.js';
import { firstMessages } from './first-message.js';

vi.mock('@tanstack/react-router', async (original) =>
  (await import('../extensions/test-router.js')).mockRouter(original),
);

const STREAM_URL = 'https://agent.test/chats/chat-1/stream';

function show(element: ReactNode, over: { session?: Partial<Session>; objects?: unknown[] } = {}) {
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
            ...over.session,
          } as Session,
          schema: { objects: over.objects ?? [] } as unknown as SchemaDescription,
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

function chat(over: { running?: boolean; messages?: unknown[] } = {}) {
  return vi.spyOn(api, 'agentChat').mockResolvedValue({
    id: 'chat-1',
    title: 'Who is Dana?',
    running: over.running ?? false,
    messages: (over.messages ?? saved) as never,
  });
}

/** A new chat, and the server's copy of it once a turn has ended. */
function chatAfterTurn(messages: unknown[], title: string | null = 'Who is Dana?') {
  return vi
    .spyOn(api, 'agentChat')
    .mockResolvedValueOnce({ id: 'chat-1', title, running: false, messages: [] })
    .mockResolvedValue({
      id: 'chat-1',
      title: title ?? 'Tell me about Acme',
      running: false,
      messages: messages as never,
    });
}
const asked = (text: string) => ({ id: 'u2', role: 'user', parts: [{ type: 'text', text }] });

/** A turn's ending as the chat read places it: after the turn's messages. */
const ended = (status: string) => ({
  id: 'end',
  role: 'assistant',
  parts: [{ type: 'data-turn-end', data: { status, code: null } }],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.reset();
});

describe('ChatPage', () => {
  it('shows saved messages: the question, the steps folded into one line, and the answer', async () => {
    router.params = { id: 'chat-1' };
    chat();
    show(<ChatPage />);
    expect(await screen.findByText('Who is Dana?', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('CTO').tagName).toBe('STRONG');
    // A finished run of steps is one line saying what the agent did.
    const summary = screen.getByRole('button', { name: /Checked your workspace\s*2 steps/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Searched for “Dana”')).toBeNull();
    await userEvent.click(summary);
    expect(screen.getByText('Searched for “Dana”')).toBeTruthy();
    // The thinking is its own line inside, folded until opened.
    const thought = screen.getByRole('button', { name: 'Thought' });
    expect(screen.queryByText('Look her up first.')).toBeNull();
    await userEvent.click(thought);
    expect(screen.getByText('Look her up first.')).toBeTruthy();
  });

  it('puts a question back in the message box to edit, focused', async () => {
    router.params = { id: 'chat-1' };
    chat();
    show(<ChatPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit and send again' }));
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Who is Dana?');
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.selectionStart).toBe('Who is Dana?'.length);
  });

  it('sends exactly one text part to the stream URL with a fresh token, and streams the answer', async () => {
    router.params = { id: 'chat-1' };
    chatAfterTurn([
      asked('Tell me about Acme'),
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search',
            toolCallId: 't2',
            state: 'output-available',
            input: { query: 'Acme' },
            output: { results: [] },
          },
          { type: 'text', text: 'Acme is a customer.', state: 'done' },
        ],
      },
    ]);
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
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
    const detail = chatAfterTurn(
      [
        asked('Tell me about Acme'),
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Acme is a customer.' }] },
      ],
      null,
    );
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
    // The server's copy replaced what was streamed, answer included.
    expect(await screen.findByText('Acme is a customer.')).toBeTruthy();
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('says in plain words how a turn ended, and offers a new chat when this one is over', async () => {
    router.params = { id: 'chat-1' };
    chatAfterTurn([asked('Hi'), ended('context_limit_reached')]);
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
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

  it("doesn't let a copy fetched mid-turn replace the stream, and takes the server's after", async () => {
    router.params = { id: 'chat-1' };
    const detail = vi
      .spyOn(api, 'agentChat')
      .mockResolvedValueOnce({ id: 'chat-1', title: 'Hi', running: false, messages: [] })
      // Mid-turn: only the person's message is saved yet.
      .mockResolvedValueOnce({
        id: 'chat-1',
        title: 'Hi',
        running: true,
        messages: [asked('Hi')] as never,
      })
      .mockResolvedValue({
        id: 'chat-1',
        title: 'Hi',
        running: false,
        messages: [
          asked('Hi'),
          { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Hello there.' }] },
          ended('refused'),
        ] as never,
      });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    const encoder = new TextEncoder();
    let finish = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const write = (chunk: unknown) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                write({ type: 'start', messageId: 'a2' });
                write({ type: 'text-start', id: 'x' });
                write({ type: 'text-delta', id: 'x', delta: 'Hello there.' });
                finish = () => {
                  write({ type: 'text-end', id: 'x' });
                  write({ type: 'data-turn-end', data: { status: 'refused', code: null } });
                  write({ type: 'finish' });
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                };
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
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hi{Enter}');
    expect(await screen.findByText('Hello there.')).toBeTruthy();
    // The person leaves the tab and comes back: the chat is fetched mid-turn.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Hello there.')).toBeTruthy();
    finish();
    // The turn ended: the server's copy, with its ending, is what shows.
    expect(await screen.findByText('The agent declined to answer this.')).toBeTruthy();
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Hello there.')).toBeTruthy();
    expect(screen.getByText('The agent declined to answer this.')).toBeTruthy();
    expect(document.querySelector('.retainer-mark[data-mood="error"]')).toBeTruthy();
  });

  it('shows how a turn ended after a reload, from the saved chat', async () => {
    router.params = { id: 'chat-1' };
    chat({ messages: [...saved, ended('context_limit_reached')] });
    show(<ChatPage />);
    expect(await screen.findByText(/too long to continue/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start a new chat' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('after Stop, shows the saved chat, and checks back until the runtime has stopped', async () => {
    router.params = { id: 'chat-1' };
    let runtimeStopped = false;
    let opened = false;
    const detail = vi.spyOn(api, 'agentChat').mockImplementation(async () => {
      if (!opened) {
        opened = true;
        return { id: 'chat-1', title: 'Who is Dana?', running: false, messages: [] };
      }
      // Cancelled; until the runtime stops, the step it was on isn't saved yet.
      if (!runtimeStopped)
        return {
          id: 'chat-1',
          title: 'Who is Dana?',
          running: false,
          stopping: true,
          messages: [...saved.slice(0, 1), ended('cancelled')] as never,
        };
      return {
        id: 'chat-1',
        title: 'Who is Dana?',
        running: false,
        stopping: false,
        messages: [
          ...saved.slice(0, 1),
          {
            id: 'a2',
            role: 'assistant',
            parts: [
              { type: 'text', text: 'Dana is a buyer at Acme.' },
              { type: 'data-turn-end', data: { status: 'cancelled', code: null } },
            ],
          },
        ] as never,
      };
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
    expect(await screen.findByText('Stopping…')).toBeTruthy();
    await waitFor(() => expect(detail.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByText('Stopped.')).toBeNull();
    expect(document.querySelector('.retainer-mark[data-mood="stopping"]')).toBeTruthy();
    expect(screen.getByText('Who is Dana?', { selector: 'div' })).toBeTruthy();
    // The runtime saves its step and stops; only checking back can show it.
    const calls = detail.mock.calls.length;
    runtimeStopped = true;
    expect(await screen.findByText('Dana is a buyer at Acme.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Stopped.')).toBeTruthy();
    expect(screen.queryByText('Stopping…')).toBeNull();
    expect(document.querySelector('.retainer-mark[data-mood="idle"]')).toBeTruthy();
    expect(detail.mock.calls.length).toBeGreaterThan(calls);
  }, 10_000);

  it('explains a refused message: another turn is still running', async () => {
    router.params = { id: 'chat-1' };
    const detail = chat({ messages: [] });
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
    // No turn ran, so the saved copy doesn't have the message: it stays on screen.
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Hi', { selector: 'div' })).toBeTruthy();
  });

  it('shows the saved answer when a started turn loses its stream before the first word', async () => {
    router.params = { id: 'chat-1' };
    chatAfterTurn([
      asked('Hi'),
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello from the saved copy.' }],
      },
    ]);
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    // The runtime claimed the turn and saved the message, then the connection dropped.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'data-received', data: { messageId: 'u2' }, transient: true })}\n\n`,
                  ),
                );
                setTimeout(() => controller.error(new TypeError('network error')), 50);
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
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hi{Enter}');
    expect(await screen.findByText('Hello from the saved copy.')).toBeTruthy();
    // Not shown twice: the turn ran, so the saved copy has the message.
    expect(screen.getAllByText('Hi', { selector: 'div' })).toHaveLength(1);
  });

  it('keeps a message refused while the last turn stops, and still shows the step saved after Stop', async () => {
    router.params = { id: 'chat-1' };
    let runtimeStopped = false;
    vi.spyOn(api, 'agentChat').mockImplementation(async () => ({
      id: 'chat-1',
      title: 'Who is Dana?',
      running: false,
      stopping: !runtimeStopped,
      messages: [
        ...saved.slice(0, 1),
        runtimeStopped
          ? {
              id: 'a2',
              role: 'assistant',
              parts: [
                { type: 'text', text: 'Dana is a buyer at Acme.' },
                { type: 'data-turn-end', data: { status: 'cancelled', code: null } },
              ],
            }
          : ended('cancelled'),
      ] as never,
    }));
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'agentChatToken').mockResolvedValue({
      token: 't',
      expiresAt: '',
      streamUrl: STREAM_URL,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'turn_stopping' }), { status: 409 })),
    );
    show(<ChatPage />);
    expect(await screen.findByText('Stopping…')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Hi{Enter}');
    expect(await screen.findByText(/still stopping/)).toBeTruthy();
    expect(screen.getByText('Stopping…')).toBeTruthy();
    expect(screen.queryByText('Stopped.')).toBeNull();
    runtimeStopped = true;
    expect(await screen.findByText('Dana is a buyer at Acme.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Hi', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('Stopped.')).toBeTruthy();
  }, 10_000);

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

describe('ChatsPage starters (chat-builds.md §5.2)', () => {
  const companies = { nameSingular: 'company', namePlural: 'companies', labelPlural: 'Companies' };
  const prompts = {
    dashboard: 'Suggest a few dashboards I could build from this workspace’s data.',
    view: 'Suggest a few views of Companies I could keep.',
    routine: 'Suggest a few routines that would save time in this workspace.',
  };

  it.each([
    ['dashboard', {}, /Pin it to keep it/],
    ['view', { object: 'company' }, /Save it to keep it/],
    ['routine', {}, /an admin approves it before anything runs/],
  ] as const)('shows the %s steps and one prompt, creating no chat', async (kind, extra, about) => {
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    const create = vi.spyOn(api, 'createAgentChat');
    router.search = { new: kind, ...extra };
    show(<ChatsPage />, { session: { routinesAvailable: true }, objects: [companies] });
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    expect(screen.getByText(about)).toBeTruthy();
    const suggestions = within(screen.getByRole('list', { name: 'Suggestions' })).getAllByRole(
      'button',
    );
    expect(suggestions.map((b) => b.textContent)).toEqual([prompts[kind]]);
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the prompt as the first message of a new chat', async () => {
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    const create = vi
      .spyOn(api, 'createAgentChat')
      .mockResolvedValue({ id: 'chat-7', title: null, createdAt: '2026-11-28T00:00:00Z' });
    router.search = { new: 'view', object: 'company' };
    show(<ChatsPage />, { objects: [companies] });
    expect(
      (await screen.findByRole('textbox', { name: 'Message' })).getAttribute('placeholder'),
    ).toBe('Describe a view of Companies…');
    await userEvent.click(screen.getByRole('button', { name: prompts.view }));
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/chat/$id', params: { id: 'chat-7' } }),
    );
    expect(create).toHaveBeenCalledWith(undefined, 'web');
    expect(firstMessages.get('chat-7')).toBe(prompts.view);
    firstMessages.delete('chat-7');
  });

  it.each([
    ['routines off', { new: 'routine' }, {}],
    ['no write', { new: 'dashboard' }, { scopes: ['read'] }],
    ['an unknown object', { new: 'view', object: 'deal' }, {}],
  ] as const)('shows the plain index for %s', async (_, search, session) => {
    vi.spyOn(api, 'agentChats').mockResolvedValue({ chats: [] });
    router.search = search;
    show(<ChatsPage />, { session: session as Partial<Session>, objects: [companies] });
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What should I follow up on?' })).toBeTruthy();
  });
});
