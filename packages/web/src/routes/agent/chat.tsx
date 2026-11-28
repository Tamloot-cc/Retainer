import { useChat } from '@ai-sdk/react';
import type { AgentChatDetail } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowUp, MessageSquarePlus, Square, Trash2 } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { MessageScroller, MessageScrollerItem } from '../../ui/message.js';
import { QueryError } from '../state.js';
import { firstMessages, newChat } from './first-message.js';
import { ChatMessages } from './messages.js';
import {
  agentKey,
  avatarMood,
  CHAT_OVER,
  type ChatMessage,
  MOOD_TEXT,
  messageText,
  RETRYABLE,
  sendErrorText,
  turnEnd,
} from './model.js';
import { chatTransport } from './transport.js';

const ABOUT =
  'Ask the agent about your workspace. It reads your records, searches the web and saves what it learns, as an agent working for you. Its changes never outrank a person’s.';

/** The column a chat's thread and message box share. */
const COLUMN = 'mx-auto w-full max-w-3xl px-4 md:px-8';

/** One-click questions for an empty chat (shadcn/ui Suggestion). They work in any workspace. */
const SUGGESTIONS = [
  'What should I follow up on?',
  'What happened in my recent conversations?',
  'How is this workspace set up?',
  'What do you remember about me?',
];

function Suggestions({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  return (
    <ul
      aria-label="Suggestions"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
    >
      {SUGGESTIONS.map((suggestion) => (
        <li key={suggestion} className="shrink-0">
          <Button
            size="small"
            disabled={disabled}
            className="rounded-full px-3 font-normal md:h-7"
            onClick={() => onSend(suggestion)}
          >
            {suggestion}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The box a message is typed in (shadcn/ui Prompt Input): the text on top, the
 * send or stop button under it. Enter sends; Shift+Enter starts a new line.
 */
function Composer({
  text,
  onText,
  onSend,
  onStop,
  busy,
  disabled,
  field,
  placeholder = 'Ask the agent…',
}: {
  /** The text box, for a parent that puts a message back to edit. */
  field?: Ref<HTMLTextAreaElement>;
  text: string;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || busy || disabled) return;
    onSend(message);
    onText('');
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
      className="flex flex-col rounded-2xl border border-border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 has-disabled:opacity-60"
    >
      <textarea
        ref={field}
        aria-label="Message"
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={key}
        dir="auto"
        className="max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <span className="hidden ps-1.5 text-xs text-muted-foreground/80 md:inline">
          Shift+Enter for a new line
        </span>
        {busy && onStop ? (
          <Button
            variant="outline"
            size="icon"
            className="ms-auto rounded-full"
            aria-label="Stop"
            title="Stop"
            onClick={onStop}
          >
            <Square size={12} className="fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size="icon"
            className="ms-auto rounded-full"
            aria-label="Send"
            title="Send"
            disabled={busy || disabled || !text.trim()}
          >
            <ArrowUp size={16} />
          </Button>
        )}
      </div>
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
    mutationFn: (text: string | undefined) => newChat(text),
    onSuccess: (chat) => void navigate({ to: '/chat/$id', params: { id: chat.id } }),
  });
  const [draft, setDraft] = useState('');
  const startChat = (text: string) => start.mutate(text);
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
      <div className="flex flex-col gap-3">
        <Composer text={draft} onText={setDraft} busy={start.isPending} onSend={startChat} />
        <Suggestions disabled={start.isPending} onSend={startChat} />
      </div>
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
    // A turn still running from an earlier visit, or one still stopping (a step it was
    // on may yet be saved): check back until it ends (spec §6.5).
    refetchInterval: (query) =>
      query.state.data?.running || query.state.data?.stopping ? 2500 : false,
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
  return <Conversation key={id} chat={detail.data} updatedAt={detail.dataUpdatedAt} />;
}

/** `updatedAt`: when `chat` was fetched. */
function Conversation({ chat, updatedAt }: { chat: AgentChatDetail; updatedAt: number }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const transport = useMemo(() => chatTransport(chat.id), [chat.id]);
  const [draft, setDraft] = useState('');
  const [outcome, setOutcome] = useState<'done' | 'error' | null>(null);
  const typing = draft.trim() !== '';
  const field = useRef<HTMLTextAreaElement>(null);
  const updateDraft = useCallback((text: string) => {
    setDraft(text);
    setOutcome((current) => (current === 'error' ? null : current));
  }, []);
  // Puts one of the person's messages back in the box, focused with the cursor at its end.
  const edit = useCallback(
    (text: string) => {
      updateDraft(text);
      requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.setSelectionRange(text.length, text.length);
      });
    },
    [updateDraft],
  );
  const [deleting, setDeleting] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // Messages refused before a turn started, shown after the saved ones until the next send.
  const [refused, setRefused] = useState<ChatMessage[]>([]);
  const received = useRef(false);
  const detailKey = [...agentKey(session.workspace.id), 'chat', chat.id];
  // The list's titles and times, and this chat: its title (set by its first message)
  // and its saved messages, which replace the streamed ones once a turn ends.
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
      // The runtime sends `data-received` once it has claimed the turn and saved the message.
      onData: (part) => {
        if (part.type === 'data-received') received.current = true;
      },
      onFinish: ({ isAbort, isError, messages: shown }) => {
        // Refused before a turn started (another turn running or stopping, today's
        // limit, the agent unavailable): the saved copy has no trace of the message, so
        // it stays on screen after the saved copy, with the refusal.
        const last = shown.at(-1);
        const ending =
          last?.role === 'assistant' ? last.parts.map(turnEnd).findLast(Boolean) : undefined;
        if (isAbort || ending === 'cancelled') setOutcome(null);
        else if (isError || (ending && ending !== 'completed')) setOutcome('error');
        else if (last?.role === 'assistant') setOutcome('done');
        if (isError && !received.current && last?.role === 'user')
          setRefused((before) => [...before, last]);
        void turnSettled();
      },
    });
  const busy = status === 'submitted' || status === 'streaming';
  // A turn running from before this page opened: show what was saved, and its end once it lands.
  const runningBefore = chat.running && !busy;
  // The server's copy is the chat (agent spec §6.1): it has every turn's ending. It
  // replaces what was streamed once fetched after the turn on this page ended (its end,
  // or Stop); a copy fetched mid-turn (a focus refetch) never replaces the stream.
  const staleBefore = useRef(0);
  const turnSettled = () => {
    staleBefore.current = Date.now();
    return refresh();
  };
  useEffect(() => {
    if (!busy && updatedAt >= staleBefore.current) setMessages(chat.messages as ChatMessage[]);
  }, [busy, updatedAt, chat.messages, setMessages]);

  const send = (text: string) => {
    staleBefore.current = Number.POSITIVE_INFINITY;
    received.current = false;
    setRefused([]);
    clearError();
    setOutcome(null);
    setStopError(null);
    void sendMessage({ text });
  };
  const first = useRef(firstMessages.get(chat.id));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends the handed-over message once.
  useEffect(() => {
    const text = first.current;
    if (!text || runningBefore || chat.stopping) return;
    first.current = undefined;
    firstMessages.delete(chat.id);
    send(text);
  }, [chat.id, runningBefore, chat.stopping]);

  const cancel = useMutation({
    mutationFn: () => api.cancelAgentChat(chat.id),
    onError: () => setStopError("The agent couldn't be stopped. Try again."),
    // Stop cut the stream that would have carried the turn's ending: the saved chat,
    // fetched once the cancel lands, has it.
    onSettled: turnSettled,
  });
  const onStop = () => {
    setOutcome(null);
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

  const lastEnding = messages.at(-1)?.parts.map(turnEnd).findLast(Boolean);
  const over = lastEnding !== undefined && CHAT_OVER.has(lastEnding);
  // A turn is going (this page's, or one running from before): nothing new can be sent.
  const working = busy || runningBefore;
  const locked = working || over;
  const stopping = cancel.isPending || !!chat.stopping;
  const mood = avatarMood({ status, messages, typing, outcome, running: runningBefore, stopping });
  // Sent, and no part of the answer has arrived yet.
  const awaitingAnswer =
    mood === 'thinking' && status === 'submitted' && messages.at(-1)?.role === 'user';
  const showIntro = messages.length === 0 && refused.length === 0 && !awaitingAnswer;
  const avatarInThread =
    showIntro || (refused.length === 0 && messages.at(-1)?.role === 'assistant');
  const showProgress = stopping || (mood === 'working' && runningBefore);
  const moodText = stopping
    ? MOOD_TEXT.stopping
    : mood === 'working' && runningBefore
      ? 'Still working on your last message…'
      : MOOD_TEXT[mood];
  // The last answer ended short of done and the chat can go on: offer to ask again.
  const retryable =
    !locked &&
    !stopping &&
    lastEnding !== undefined &&
    RETRYABLE.has(lastEnding) &&
    messages.at(-1)?.role === 'assistant';
  const lastQuestion = messageText(messages.findLast((m) => m.role === 'user') ?? { parts: [] });
  // Stable, so the memoized last answer doesn't render again on every keystroke.
  const again = useRef(() => {});
  again.current = () => send(lastQuestion);
  const retry = useCallback(() => again.current(), []);
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
      <MessageScroller label="Messages" className="flex-1" contentClassName={`${COLUMN} py-6`}>
        {showIntro ? (
          <MessageScrollerItem messageId="intro">
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <LogoMark mood={mood} size={32} className="shrink-0" />
                <p className="pt-1.5 text-sm text-muted-foreground">{ABOUT}</p>
              </div>
              {locked ? null : (
                <div className="ps-11">
                  <Suggestions onSend={send} />
                </div>
              )}
            </div>
          </MessageScrollerItem>
        ) : (
          <ChatMessages
            scroller
            chatId={chat.id}
            messages={refused.length > 0 ? [...messages, ...refused] : messages}
            streaming={status === 'streaming'}
            waiting={awaitingAnswer}
            stoppingMessageId={chat.stopping ? chat.messages.at(-1)?.id : undefined}
            mood={mood}
            onEdit={locked ? undefined : edit}
            onRetry={retryable && lastQuestion ? retry : undefined}
          />
        )}
      </MessageScroller>
      <div className="shrink-0 bg-background">
        <div className={`${COLUMN} flex flex-col gap-2 pt-1 pb-4`}>
          {/* Announce each step, and show a visible status for cancellation or a turn
              already running when the page opened. */}
          <p
            role="status"
            className={
              showProgress ? 'flex items-center gap-2 text-xs text-muted-foreground' : 'sr-only'
            }
          >
            {showProgress && !avatarInThread && mood !== 'error' ? <LogoMark mood={mood} /> : null}
            {moodText ?? ''}
          </p>
          {error ? (
            <Notice error onDismiss={clearError}>
              <span className="flex items-center gap-2">
                {!avatarInThread ? <LogoMark mood="error" /> : null}
                {sendErrorText(error)}
              </span>
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
              field={field}
              text={draft}
              onText={updateDraft}
              busy={working}
              onSend={send}
              onStop={working ? onStop : undefined}
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
