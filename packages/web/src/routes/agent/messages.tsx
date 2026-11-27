import {
  ArrowUpRight,
  BookOpen,
  Brain,
  CircleAlert,
  CircleCheck,
  Globe,
  LoaderCircle,
  NotebookPen,
  Pencil,
  RotateCcw,
  Save,
  Search,
  Wrench,
} from 'lucide-react';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { Button, CopyButton, JsonBlock, LogoMark, type LogoMood, Notice } from '../../ui/index.js';
import {
  Bubble,
  Message,
  MessageContent,
  MessageFooter,
  MessageScrollerItem,
} from '../../ui/message.js';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  type TraceStatus,
  TraceTitle,
} from '../../ui/trace.js';
import { type BlockHistory, ChatAnswer, extendBlockHistory } from './chat-blocks.js';
import {
  answerText,
  type ChatMessage,
  type ChatPart,
  groupTraceParts,
  hostname,
  isToolPart,
  messageText,
  segmentParts,
  sourceLinks,
  stepsSummary,
  type ToolKind,
  type ToolPart,
  TURN_ENDINGS,
  toolError,
  toolErrorText,
  toolFinished,
  toolGroupLine,
  toolHasFailures,
  toolKind,
  toolLine,
  turnEnd,
  webResults,
} from './model.js';

const EMPTY_BLOCK_HISTORY: BlockHistory = {};

const KIND_ICONS: Record<ToolKind, typeof Search> = {
  search: Search,
  web: Globe,
  read: BookOpen,
  save: Save,
  remember: NotebookPen,
  other: Wrench,
};

/** A step's icon: a spinner while it runs, an alert if it failed, else what kind of step it is. */
function StepIcon({ status, icon: Icon }: { status?: TraceStatus; icon: typeof Search }) {
  return (
    <TraceIcon>
      {status === 'running' ? (
        <LoaderCircle className="motion-safe:animate-spin" />
      ) : status === 'error' ? (
        <CircleAlert />
      ) : (
        <Icon />
      )}
    </TraceIcon>
  );
}

/** A step's line: its icon and title, with the same status on both. */
function StepLine({
  status,
  icon,
  hideSpinner,
  children,
}: {
  status?: TraceStatus;
  icon: typeof Search;
  hideSpinner?: boolean;
  children: ReactNode;
}) {
  return (
    <TraceLine status={status}>
      {hideSpinner && status === 'running' ? null : <StepIcon status={status} icon={icon} />}
      {children}
    </TraceLine>
  );
}

/**
 * A line that opens while `live` and closes when it's done, unless the
 * person opened or closed it: then their choice holds (shadcn/ui Trace's
 * open state).
 */
function useLiveOpen(live: boolean) {
  const [open, setOpen] = useState<boolean>();
  return { open: open ?? live, onOpenChange: setOpen };
}

function ReasoningStep({
  text,
  running,
  hideSpinner,
}: {
  text: string;
  running: boolean;
  hideSpinner?: boolean;
}) {
  const openState = useLiveOpen(running);
  const line = (
    <StepLine status={running ? 'running' : undefined} icon={Brain} hideSpinner={hideSpinner}>
      <TraceTitle>{running ? 'Thinking' : 'Thought'}</TraceTitle>
    </StepLine>
  );
  // Nothing to open before the model has written anything.
  if (!text.trim()) return line;
  return (
    <TraceCollapsible {...openState}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap text-xs" dir="auto">
        {text}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** The sites a web search found, as chips that open the page. */
function WebResults({ results }: { results: { url: string; title?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Pages found">
      {results.map((result) => (
        <li key={result.url}>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            title={result.title}
            className="inline-flex max-w-56 items-center rounded-md bg-muted px-2 py-0.5 text-xs text-foreground/80 hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{hostname(result.url)}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function ToolStep({
  part,
  streaming,
  hideSpinner,
}: {
  part: ToolPart;
  streaming: boolean;
  hideSpinner?: boolean;
}) {
  const finished = toolFinished(part);
  const error = toolError(part);
  const failed = toolHasFailures(part);
  const line = toolLine(part);
  // A call the turn ended without finishing (stopped or cut short) isn't running any more.
  const status: TraceStatus | undefined = !finished
    ? streaming
      ? 'running'
      : 'pending'
    : failed
      ? 'error'
      : undefined;
  const title = (
    <StepLine status={status} icon={KIND_ICONS[toolKind(part)]} hideSpinner={hideSpinner}>
      <TraceTitle>{error ? `${line}, but ${toolErrorText(error)}` : line}</TraceTitle>
    </StepLine>
  );
  if (!finished) return title;
  const results = webResults(part);
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{title}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
        {results.length ? (
          <WebResults results={results} />
        ) : (
          <>
            {part.input !== undefined ? <JsonBlock label="Input" value={part.input} /> : null}
            {part.state === 'output-available' ? (
              <JsonBlock label="Result" value={part.output} />
            ) : null}
            {part.state === 'output-error' && part.errorText ? (
              <p className="text-destructive">{part.errorText}</p>
            ) : null}
          </>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Steps as lines: adjacent finished calls to the same tool fold into one (`groupTraceParts`). */
function StepLines({
  parts,
  lines,
  streaming,
  hideSpinner,
}: {
  parts: ChatPart[];
  lines: ReturnType<typeof groupTraceParts>;
  streaming: boolean;
  hideSpinner?: boolean;
}) {
  return (
    <Trace>
      {lines.map((entry) => {
        if ('calls' in entry) {
          const { calls } = entry;
          const [first] = calls;
          if (calls.length === 1)
            return (
              <ToolStep
                key={entry.index}
                part={first}
                streaming={streaming}
                hideSpinner={hideSpinner}
              />
            );
          const status = toolHasFailures(first) ? 'error' : undefined;
          return (
            <TraceCollapsible key={entry.index}>
              <TraceCollapsibleTrigger>
                <StepLine status={status} icon={KIND_ICONS[toolKind(first)]}>
                  <TraceTitle>{toolGroupLine(calls)}</TraceTitle>
                </StepLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <Trace>
                  {calls.map((call, index) => (
                    <ToolStep key={call.toolCallId ?? index} part={call} streaming={streaming} />
                  ))}
                </Trace>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          );
        }
        const { part, index } = entry;
        if (part.type === 'reasoning')
          return (
            <ReasoningStep
              key={index}
              text={part.text}
              running={streaming && index === parts.length - 1 && part.state !== 'done'}
              hideSpinner={hideSpinner}
            />
          );
        if (isToolPart(part))
          return (
            <ToolStep key={index} part={part} streaming={streaming} hideSpinner={hideSpinner} />
          );
        return null;
      })}
    </Trace>
  );
}

/** What the agent is doing now, from its latest step. */
function currentStep(parts: ChatPart[]) {
  const last = parts.at(-1);
  if (last && isToolPart(last)) return { title: toolLine(last), icon: KIND_ICONS[toolKind(last)] };
  return { title: 'Thinking', icon: Brain };
}

/**
 * A run of steps between pieces of the answer (shadcn/ui Chain of Thought).
 * While it runs, its line says what the agent is doing now and the steps
 * show under it; once done, it folds into one line saying what it did.
 */
function Steps({
  parts,
  live,
  hideSpinner,
}: {
  parts: ChatPart[];
  live: boolean;
  hideSpinner: boolean;
}) {
  const openState = useLiveOpen(live);
  const lines = groupTraceParts(parts);
  if (lines.length === 1)
    return <StepLines parts={parts} lines={lines} streaming={live} hideSpinner={hideSpinner} />;
  const failed = parts.some((part) => isToolPart(part) && toolHasFailures(part));
  const now = currentStep(parts);
  const status: TraceStatus | undefined = live ? 'running' : failed ? 'error' : undefined;
  return (
    <Trace>
      <TraceCollapsible {...openState}>
        <TraceCollapsibleTrigger>
          <StepLine status={status} icon={live ? now.icon : CircleCheck} hideSpinner={hideSpinner}>
            <TraceTitle>{live ? now.title : stepsSummary(parts)}</TraceTitle>
            <TraceDescription>
              {parts.length} {parts.length === 1 ? 'step' : 'steps'}
            </TraceDescription>
          </StepLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <StepLines parts={parts} lines={lines} streaming={live} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** The links a reply used, folded into one line. */
function Sources({ parts }: { parts: ChatPart[] }) {
  const links = sourceLinks(parts);
  if (!links.length) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <Globe />
            </TraceIcon>
            <TraceTitle>
              Used {links.length} {links.length === 1 ? 'source' : 'sources'}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
                <TraceLine>
                  <TraceIcon>
                    <Globe />
                  </TraceIcon>
                  <TraceTitle>
                    {link.title || hostname(link.url)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </TraceTitle>
                  <TraceIcon>
                    <ArrowUpRight />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** An icon button under a message. */
function FooterAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="iconSmall" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The shared copy button, sized like the footer's other icon buttons. */
function CopyMessage({ text, label }: { text: string; label: string }) {
  return (
    <CopyButton value={text} label={label} iconOnly className="h-8 min-w-8 md:h-6 md:min-w-6" />
  );
}

/** One assistant message: its steps, answer, endings and sources, in order. */
function AssistantParts({
  message,
  streaming,
  stopping,
  history,
  chatId,
  hasMark,
}: {
  message: ChatMessage;
  history: BlockHistory;
  chatId?: string;
  streaming: boolean;
  stopping: boolean;
  hasMark: boolean;
}) {
  const segments = segmentParts(message.parts);
  return (
    <>
      {segments.map((segment, at) => {
        const key = `${message.id}-${segment.index}`;
        const last = at === segments.length - 1;
        if (segment.kind === 'steps')
          return (
            <Steps
              key={key}
              parts={segment.parts}
              live={streaming && last}
              hideSpinner={hasMark && at === 0}
            />
          );
        const { part } = segment;
        if (part.type === 'text') {
          const previous = history;
          history = extendBlockHistory(history, part.text);
          return (
            <ChatAnswer
              key={key}
              text={part.text}
              history={previous}
              chatId={chatId}
              streaming={streaming && last}
            />
          );
        }
        const ending = turnEnd(part);
        if (ending === 'cancelled' && stopping) return null;
        if (ending)
          return (
            <Notice key={key} error={ending !== 'cancelled'} announce={false}>
              {TURN_ENDINGS[ending] ?? TURN_ENDINGS.failed}
            </Notice>
          );
        return null;
      })}
      <Sources parts={message.parts} />
    </>
  );
}

/** The agent's side of a turn: its mark (or the room for it) and what it said. */
function AgentTurn({ mark, children }: { mark?: ReactNode; children: ReactNode }) {
  return (
    <Message aria-label="The agent">
      {mark ?? <span aria-hidden className="w-8 shrink-0" />}
      <MessageContent className="pt-1.5">{children}</MessageContent>
    </Message>
  );
}

/**
 * One of the person's messages. Memoized, like `AgentMessage`: while an
 * answer streams, only the message that changed renders again.
 */
const UserMessage = memo(function UserMessage({
  message,
  actions,
  onEdit,
}: {
  message: ChatMessage;
  actions: boolean;
  onEdit?: (text: string) => void;
}) {
  const text = messageText(message);
  return (
    <Message align="end" aria-label="You">
      <MessageContent>
        <Bubble>{text}</Bubble>
        {actions ? (
          <MessageFooter>
            <CopyMessage text={text} label="Copy message" />
            {onEdit ? (
              <FooterAction label="Edit and send again" onClick={() => onEdit(text)}>
                <Pencil size={14} />
              </FooterAction>
            ) : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
});

const AgentMessage = memo(function AgentMessage({
  message,
  answering,
  last,
  actions,
  mood,
  stopping,
  onRetry,
  history,
  chatId,
}: {
  message: ChatMessage;
  history: BlockHistory;
  chatId?: string;
  answering: boolean;
  last: boolean;
  actions: boolean;
  /** Set on the message that shows the mark. */
  mood?: LogoMood;
  stopping: boolean;
  onRetry?: () => void;
}) {
  const answer = answerText(message);
  return (
    <AgentTurn mark={mood ? <LogoMark mood={mood} size={32} className="shrink-0" /> : undefined}>
      <AssistantParts
        message={message}
        streaming={answering}
        stopping={stopping}
        history={history}
        chatId={chatId}
        hasMark={Boolean(mood)}
      />
      {actions && !answering && (answer || onRetry) ? (
        <MessageFooter pinned={last}>
          {answer ? <CopyMessage text={answer} label="Copy answer" /> : null}
          {onRetry ? (
            <FooterAction label="Try again" onClick={onRetry}>
              <RotateCcw size={14} />
            </FooterAction>
          ) : null}
        </MessageFooter>
      ) : null}
    </AgentTurn>
  );
});

/**
 * A chat's messages, oldest first (agent spec §6). The person's messages sit
 * on the end side in a bubble. The agent's last message carries its mark,
 * showing `mood`; one moving mark per chat is enough.
 * Also renders a task's saved messages read-only.
 *
 * In a `MessageScroller` (`scroller`), each message is one of its items and
 * the person's messages are its anchors; otherwise they're a list.
 */
export function ChatMessages({
  messages,
  chatId,
  streaming = false,
  mood = 'idle',
  mark = true,
  waiting = false,
  stoppingMessageId,
  scroller = false,
  onEdit,
  onRetry,
}: {
  messages: ChatMessage[];
  chatId?: string;
  /** The last message is still arriving. */
  streaming?: boolean;
  mood?: LogoMood;
  /** False for a saved trace: nothing is happening, so no mark moves and there are no actions. */
  mark?: boolean;
  /** Sent, and nothing of the answer has arrived yet. */
  waiting?: boolean;
  /** The saved answer whose runtime is still stopping. */
  stoppingMessageId?: string;
  scroller?: boolean;
  /** Puts one of the person's messages back in the message box. */
  onEdit?: (text: string) => void;
  /** Sends the last message again; offered under the last answer. */
  onRetry?: () => void;
}) {
  const histories = useMemo(() => {
    let history = EMPTY_BLOCK_HISTORY;
    return messages.map((message) => {
      const previous = history;
      if (message.role === 'user')
        history = extendBlockHistory(history, messageText(message), true);
      if (message.role === 'assistant') {
        for (const part of message.parts) {
          if (part.type === 'text') history = extendBlockHistory(history, part.text);
        }
      }
      return previous;
    });
  }, [messages]);
  const turns = messages.flatMap((message, index) => {
    const last = index === messages.length - 1;
    if (message.role === 'user') {
      return [
        {
          id: message.id,
          user: true,
          node: <UserMessage message={message} actions={mark} onEdit={onEdit} />,
        },
      ];
    }
    if (message.role !== 'assistant') return [];
    return [
      {
        id: message.id,
        user: false,
        node: (
          <AgentMessage
            message={message}
            history={histories[index] ?? EMPTY_BLOCK_HISTORY}
            chatId={chatId}
            answering={streaming && last}
            last={last}
            actions={mark}
            mood={last && mark && !waiting ? mood : undefined}
            stopping={message.id === stoppingMessageId}
            onRetry={last ? onRetry : undefined}
          />
        ),
      },
    ];
  });
  if (waiting)
    turns.push({
      id: 'waiting',
      user: false,
      node: (
        <AgentTurn mark={<LogoMark mood="thinking" size={32} className="shrink-0" />}>
          <Trace>
            <TraceLine status="running">
              <TraceTitle>Thinking</TraceTitle>
            </TraceLine>
          </Trace>
        </AgentTurn>
      ),
    });
  if (scroller)
    return turns.map((turn) => (
      <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor={turn.user}>
        {turn.node}
      </MessageScrollerItem>
    ));
  return (
    <ol className="flex flex-col gap-6" aria-label="Messages">
      {turns.map((turn) => (
        <li key={turn.id}>{turn.node}</li>
      ))}
    </ol>
  );
}
