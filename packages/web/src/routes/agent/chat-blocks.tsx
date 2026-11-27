import { type ComponentType, lazy, Suspense } from 'react';
import remend from 'remend';
import { Markdown } from '../../ui/index.js';
import { type ChatMessage, messageText } from './model.js';

type ChatBlockProps = {
  code: string;
  previous: string[];
  streaming: boolean;
  complete: boolean;
  historical: boolean;
  chatId?: string | undefined;
};

const blocks = new Map<string, ComponentType<ChatBlockProps>>([
  ['openui-lang', lazy(() => import('../dashboards/chat-block.js'))],
]);

const EMPTY_PREVIOUS: string[] = [];

type Segment =
  | { type: 'markdown'; text: string; offset: number }
  | { type: 'block'; language: string; code: string; complete: boolean; offset: number };

/** Keep unregistered fences in Markdown, including code containing a registered fence. */
export function chatSegments(text: string): Segment[] {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  const result: Segment[] = [];
  let at = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const fence = match[1];
    if (!fence) continue;
    const language = match[2]?.trim().split(/\s+/)[0] ?? '';
    // Backticks are not allowed in a backtick fence’s info string.
    if (fence[0] === '`' && match[2]?.includes('`')) continue;
    const endFence = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*(?:\\r?$)`, 'gm');
    endFence.lastIndex = opening.lastIndex;
    const close = endFence.exec(text);
    if (blocks.has(language)) {
      if (match.index > at)
        result.push({ type: 'markdown', text: text.slice(at, match.index), offset: at });
      result.push({
        type: 'block',
        language,
        code: text.slice(opening.lastIndex, close?.index ?? text.length),
        complete: !!close,
        offset: match.index,
      });
      at = close ? endFence.lastIndex : text.length;
    }
    opening.lastIndex = close ? endFence.lastIndex : text.length;
  }
  if (at < text.length) result.push({ type: 'markdown', text: text.slice(at), offset: at });
  return result;
}

export function latestChatBlock(messages: ChatMessage[]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message?.role !== 'assistant') continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex];
      if (part?.type !== 'text') continue;
      const block = chatSegments(part.text).findLast((segment) => segment.type === 'block');
      if (block) return { messageIndex, partIndex, offset: block.offset };
    }
  }
  return undefined;
}

export type BlockHistory = Readonly<Record<string, string[]>>;

export function extendBlockHistory(
  history: BlockHistory,
  text: string,
  replace = false,
): BlockHistory {
  if (!text.includes('```') && !text.includes('~~~')) return history;
  let next = history;
  for (const segment of chatSegments(text)) {
    if (segment.type === 'block' && segment.complete) {
      next = {
        ...next,
        [segment.language]: replace
          ? [segment.code]
          : [...(next[segment.language] ?? []), segment.code],
      };
    }
  }
  return next;
}

export function extendMessageBlockHistory(
  history: BlockHistory,
  message: ChatMessage,
): BlockHistory {
  if (message.role === 'user') return extendBlockHistory(history, messageText(message), true);
  if (message.role !== 'assistant') return history;
  for (const part of message.parts) {
    if (part.type === 'text') history = extendBlockHistory(history, part.text);
  }
  return history;
}

export function ChatAnswer({
  text,
  history,
  chatId,
  streaming,
  latestBlockOffset,
}: {
  text: string;
  history: BlockHistory;
  chatId?: string;
  streaming: boolean;
  latestBlockOffset?: number;
}) {
  return chatSegments(text).map((segment) => {
    if (segment.type === 'markdown') {
      if (!segment.text.trim()) return null;
      return (
        <Markdown key={segment.offset} className="text-sm leading-relaxed">
          {streaming ? remend(segment.text) : segment.text}
        </Markdown>
      );
    }
    const Block = blocks.get(segment.language);
    if (!Block) return null;
    const previous = history[segment.language] ?? EMPTY_PREVIOUS;
    if (segment.complete) history = { ...history, [segment.language]: [...previous, segment.code] };
    return (
      <Suspense
        key={segment.offset}
        fallback={<p className="text-xs text-muted-foreground">Loading preview…</p>}
      >
        <Block
          code={segment.code}
          previous={previous}
          chatId={chatId}
          streaming={streaming}
          complete={segment.complete}
          historical={segment.offset !== latestBlockOffset}
        />
      </Suspense>
    );
  });
}
