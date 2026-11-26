import { useChat } from '@ai-sdk/react';
import type { AgentChatDetail } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowUp, MessageSquarePlus, Square, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import {
  Button,
  Dialog,
  Empty,
  Loading,
  LogoMark,
  Notice,
  Page,
  RelativeTime,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
import { ChatMessages } from './messages.js';
import {
  avatarMood,
  CHAT_OVER,
  type ChatMessage,
  MOOD_TEXT,
  sendErrorText,
  TURN_ENDINGS,
  turnEnd,
} from './model.js';
import { chatTransport } from './transport.js';

export const agentKey = (workspace: string) => [workspace, 'agent'] as const;

/** A first message typed on the chat list, handed to the new chat's page to send. */
const firstMessages = new Map<string, string>();

const ABOUT =
  'Ask the agent about your workspace. It reads your records, searches the web and saves what it learns, as an agent working for you. Its changes never outrank a person’s.';

/** The box a message is typed in. Enter sends; Shift+Enter starts a new line. */
function Composer({
  onSend,
  onStop,
  onTyping,
  busy,
  disabled,
  placeholder = 'Ask the agent…',
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  onTyping?: (typing: boolean) => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || busy || disabled) return;
    onSend(message);
    setText('');
    onTyping?.(false);
  };
  // IME-safe: Enter that confirms a composition (or Safari's late one, key code 229) never sends.
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.currentTarget.form?.requestSubmit();
  };
  return (
    <form
      onSubmit={send}
      className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring"
    >
      <textarea
        aria-label="Message"
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onTyping?.(e.target.value.trim() !== '');
        }}
        onKeyDown={key}
        dir="auto"
        className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground disabled:opacity-60"
      />
      {busy && onStop ? (
        <Button variant="outline" size="icon" aria-label="Stop" title="Stop" onClick={onStop}>
          <Square size={14} />
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          size="icon"
          aria-label="Send"
          title="Send"
          disabled={busy || disabled || !text.trim()}
        >
          <ArrowUp size={16} />
        </Button>
      )}
    </form>
  );
}

/** `/chat`: the person's chats with the agent, newest first, and a box to start one. */
export function ChatsPage() {
  const { session } = useWorkspace();
  const navigate = useNavigate();
  const chats = useQuery({
    queryKey: [...agentKey(session.workspace.id), 'chats'],
    queryFn: ({ signal }) => api.agentChats(signal),
  });
  const start = useMutation({
    mutationFn: (text: string | undefined) =>
      api.createAgentChat().then((chat) => ({ chat, text })),
    onSuccess: ({ chat, text }) => {
      if (text) firstMessages.set(chat.id, text);
      void navigate({ to: '/chat/$id', params: { id: chat.id } });
    },
  });
  const list = [...(chats.data?.chats ?? [])].sort((a, b) =>
    (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt),
  );
  return (
    <Page
      title="Chat"
      description={ABOUT}
      actions={
        <Button onClick={() => start.mutate(undefined)} disabled={start.isPending}>
          <MessageSquarePlus size={14} /> New chat
        </Button>
      }
    >
      <Composer busy={start.isPending} onSend={(text) => start.mutate(text)} />
      {start.error ? <Notice error>{sendErrorText(start.error)}</Notice> : null}
      {chats.error ? (
        <QueryError error={chats.error} retry={() => void chats.refetch()} />
      ) : !chats.data ? (
        <Loading>Loading your chats…</Loading>
      ) : list.length === 0 ? (
        <Empty
          title="No chats yet"
          description="Ask a question above to start one. Only you can see your chats."
        />
      ) : (
        <section aria-label="Your chats" className="flex flex-col">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Your chats</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {list.map((chat) => (
              <li key={chat.id}>
                <Link
                  to="/chat/$id"
                  params={{ id: chat.id }}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {chat.title || 'Untitled chat'}
                  </span>
                  {chat.status === 'running' ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Answering…</span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime at={chat.lastActiveAt ?? chat.createdAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

/** `/chat/:id`: one chat. Loads the saved messages, then streams each new turn. */
export function ChatPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session } = useWorkspace();
  const key = [...agentKey(session.workspace.id), 'chat', id];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.agentChat(id, signal),
    // A turn still running from an earlier visit: check back until it ends (spec §6.5).
    refetchInterval: (query) => (query.state.data?.running ? 2500 : false),
  });
  if (detail.error)
    return (
      <Page title="Chat" eyebrow="Chat" eyebrowLink={{ to: '/chat' }}>
        <QueryError error={detail.error} retry={() => void detail.refetch()} />
      </Page>
    );
  if (!detail.data)
    return (
      <Page title="Chat" eyebrow="Chat" eyebrowLink={{ to: '/chat' }}>
        <Loading>Loading the chat…</Loading>
      </Page>
    );
  return <Conversation key={id} chat={detail.data} />;
}

function Conversation({ chat }: { chat: AgentChatDetail }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const transport = useMemo(() => chatTransport(chat.id), [chat.id]);
  const [typing, setTyping] = useState(false);
  const [ended, setEnded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // This page streamed the last turn to its end, so the stream carried its ending.
  const [streamed, setStreamed] = useState(false);
  const detailKey = [...agentKey(session.workspace.id), 'chat', chat.id];
  // The list's titles and times, and this chat's title (set by its first message). The
  // open chat keeps the messages it streamed: a refetch only replaces them for a turn
  // that was running before this page opened.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [...agentKey(session.workspace.id), 'chats'] }),
      client.invalidateQueries({ queryKey: detailKey }),
    ]);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } =
    useChat<ChatMessage>({
      id: chat.id,
      messages: chat.messages as ChatMessage[],
      transport,
      onFinish: () => {
        setEnded(true);
        void refresh();
      },
    });
  const busy = status === 'submitted' || status === 'streaming';
  // A turn running from before this page opened: show what was saved, and its end once it lands.
  const runningBefore = chat.running && !busy;
  const wasRunning = useRef(chat.running);
  useEffect(() => {
    if (wasRunning.current && !chat.running) setMessages(chat.messages as ChatMessage[]);
    wasRunning.current = chat.running;
  }, [chat.running, chat.messages, setMessages]);

  const send = (text: string) => {
    setStreamed(true);
    clearError();
    setEnded(false);
    setStopError(null);
    void sendMessage({ text });
  };
  const first = useRef(firstMessages.get(chat.id));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends the handed-over message once.
  useEffect(() => {
    const text = first.current;
    if (!text) return;
    first.current = undefined;
    firstMessages.delete(chat.id);
    send(text);
  }, [chat.id]);

  const cancel = useMutation({
    mutationFn: () => api.cancelAgentChat(chat.id),
    onError: () => setStopError("The agent couldn't be stopped. Try again."),
    onSettled: async () => {
      await refresh();
      // Stop cut the stream that would have carried the turn's ending, so read the
      // saved chat: its messages and how the turn ended. While the runtime is still
      // stopping, the effect above picks them up once it has.
      const saved = client.getQueryData<AgentChatDetail>(detailKey);
      if (saved && !saved.running) setMessages(saved.messages as ChatMessage[]);
    },
  });
  const onStop = () => {
    setStreamed(false);
    cancel.mutate();
    stop();
  };
  const remove = useMutation({
    mutationFn: () => api.deleteAgentChat(chat.id),
    onSuccess: () => {
      void refresh();
      void navigate({ to: '/chat' });
    },
  });

  const streamedEnding = messages.at(-1)?.parts.map(turnEnd).findLast(Boolean);
  // How the last turn ended when it wasn't streamed to this page (a reload, or Stop):
  // the saved messages don't carry it, the chat's detail does.
  const savedEnding =
    !streamed && !busy && !chat.running && chat.lastTurnStatus !== 'completed'
      ? (chat.lastTurnStatus ?? undefined)
      : undefined;
  const lastEnding = streamedEnding ?? savedEnding;
  const over = lastEnding !== undefined && CHAT_OVER.has(lastEnding);
  const mood = avatarMood({ status, messages, typing, ended, running: runningBefore });
  // Sent, and no part of the answer has arrived yet.
  const awaitingAnswer = status === 'submitted' && messages.at(-1)?.role === 'user';
  const moodText = runningBefore ? 'Still working on your last message…' : MOOD_TEXT[mood];
  const scroller = useRef<HTMLDivElement>(null);
  const lastPartCount = messages.at(-1)?.parts.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows new messages and parts as they stream.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastPartCount]);

  return (
    <Page
      layout="fill"
      eyebrow="Chat"
      eyebrowLink={{ to: '/chat' }}
      title={chat.title || 'New chat'}
      actions={
        <>
          <Button size="small" asChild>
            <Link to="/chat">
              <MessageSquarePlus size={14} /> New chat
            </Link>
          </Button>
          <Button
            size="iconSmall"
            variant="ghost"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={14} />
          </Button>
        </>
      }
    >
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-8">
          {messages.length === 0 ? (
            <div className="flex items-start gap-3">
              <LogoMark mood={mood} size={32} className="shrink-0" />
              <p className="pt-1.5 text-sm text-muted-foreground">{ABOUT}</p>
            </div>
          ) : (
            <ChatMessages
              messages={messages}
              streaming={status === 'streaming'}
              mood={awaitingAnswer ? 'idle' : mood}
            />
          )}
          {savedEnding && TURN_ENDINGS[savedEnding] ? (
            <Notice error={savedEnding !== 'cancelled'} announce={false}>
              {TURN_ENDINGS[savedEnding]}
            </Notice>
          ) : null}
          {awaitingAnswer ? (
            <div className="flex items-center gap-3">
              <LogoMark mood="thinking" size={32} className="shrink-0" />
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-background">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3 md:px-8">
          <p role="status" className="min-h-4 text-xs text-muted-foreground">
            {moodText ?? ''}
          </p>
          {error ? (
            <Notice error onDismiss={clearError}>
              {sendErrorText(error)}
            </Notice>
          ) : null}
          {stopError ? (
            <Notice error onDismiss={() => setStopError(null)}>
              {stopError}
            </Notice>
          ) : null}
          {over ? (
            <Notice announce={false}>
              This chat can’t continue.{' '}
              <Link to="/chat" className="underline">
                Start a new chat
              </Link>{' '}
              to keep going.
            </Notice>
          ) : (
            <Composer
              busy={busy || runningBefore}
              onSend={send}
              onStop={busy || runningBefore ? onStop : undefined}
              onTyping={setTyping}
            />
          )}
        </div>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this chat?"
        description="The chat and everything in it are erased. This can’t be undone. What the agent saved to your workspace stays."
      >
        {remove.error ? <Notice error>The chat couldn’t be deleted. Try again.</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDeleting(false)}>Cancel</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete chat
          </Button>
        </div>
      </Dialog>
    </Page>
  );
}
