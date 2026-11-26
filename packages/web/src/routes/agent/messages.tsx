import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../ui/core.js';
import { JsonBlock, LogoMark, type LogoMood, Markdown, Notice } from '../../ui/index.js';
import {
  type ChatMessage,
  type ChatPart,
  isToolPart,
  type ToolPart,
  TURN_ENDINGS,
  toolError,
  toolErrorText,
  toolLine,
  turnEnd,
} from './model.js';

/** A collapsed detail: a short summary line that opens to show more. */
function Disclosure({
  summary,
  children,
  tone = 'muted',
}: {
  summary: ReactNode;
  children: ReactNode;
  tone?: 'muted' | 'error';
}) {
  return (
    <details className="group/details text-xs">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 [&::-webkit-details-marker]:hidden',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className="shrink-0 transition-transform group-open/details:rotate-90"
        />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className="mt-1 ms-4.5 flex flex-col gap-2">{children}</div>
    </details>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text.trim() && !streaming) return null;
  return (
    <Disclosure summary={streaming ? 'Thinking…' : 'Thought about it'}>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground" dir="auto">
        {text || '…'}
      </p>
    </Disclosure>
  );
}

function ToolCall({ part }: { part: ToolPart }) {
  const error = toolError(part);
  const line = toolLine(part);
  return (
    <Disclosure
      tone={error ? 'error' : 'muted'}
      summary={error ? `${line}, but ${toolErrorText(error)}` : line}
    >
      {part.input !== undefined ? <JsonBlock label="Input" value={part.input} /> : null}
      {part.state === 'output-available' ? <JsonBlock label="Result" value={part.output} /> : null}
      {part.state === 'output-error' && part.errorText ? (
        <p className="text-xs text-destructive">{part.errorText}</p>
      ) : null}
    </Disclosure>
  );
}

function Sources({ parts }: { parts: ChatPart[] }) {
  const links = parts.flatMap((part) =>
    part.type === 'source-url' ? [{ url: part.url, title: part.title }] : [],
  );
  if (!links.length) return null;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">Sources</span>
      <ul className="flex flex-col gap-0.5">
        {links.map((link) => (
          <li key={link.url} className="truncate">
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {link.title || link.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One assistant message: its reasoning, tool calls, answer and sources, in order. */
function AssistantParts({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const parts = message.parts;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      {parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (part.type === 'reasoning')
          return (
            <Reasoning
              key={key}
              text={part.text}
              streaming={streaming && i === parts.length - 1 && part.state !== 'done'}
            />
          );
        if (part.type === 'text')
          return part.text ? (
            <Markdown key={key} className="text-sm leading-relaxed">
              {part.text}
            </Markdown>
          ) : null;
        if (isToolPart(part)) return <ToolCall key={key} part={part} />;
        const ending = turnEnd(part);
        if (ending)
          return (
            <Notice key={key} error={ending !== 'cancelled'} announce={false}>
              {TURN_ENDINGS[ending] ?? TURN_ENDINGS.failed}
            </Notice>
          );
        return null;
      })}
      <Sources parts={parts} />
    </div>
  );
}

/**
 * A chat's messages, oldest first (agent spec §6). The person's messages sit
 * on the right. The agent's last message carries its mark, showing `mood`;
 * one moving mark per chat is enough.
 * Also renders a task's saved messages read-only.
 */
export function ChatMessages({
  messages,
  streaming = false,
  mood = 'idle',
  mark = true,
}: {
  messages: ChatMessage[];
  /** The last message is still arriving. */
  streaming?: boolean;
  mood?: LogoMood;
  /** False for a saved trace: nothing is happening, so no mark moves. */
  mark?: boolean;
}) {
  return (
    <ol className="flex flex-col gap-5" aria-label="Messages">
      {messages.map((message, index) => {
        const last = index === messages.length - 1;
        if (message.role === 'user')
          return (
            <li key={message.id} className="flex justify-end">
              <div
                className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2 text-sm [overflow-wrap:anywhere]"
                dir="auto"
              >
                {message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
              </div>
            </li>
          );
        if (message.role !== 'assistant') return null;
        return (
          <li key={message.id} className="flex items-start gap-3" aria-label="The agent">
            {last && mark ? (
              <LogoMark mood={mood} size={32} className="shrink-0" />
            ) : (
              <span aria-hidden className="w-8 shrink-0" />
            )}
            <AssistantParts message={message} streaming={streaming && last} />
          </li>
        );
      })}
    </ol>
  );
}
