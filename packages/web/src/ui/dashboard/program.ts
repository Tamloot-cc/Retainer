import { mergeStatements } from '@openuidev/lang-core';

/**
 * The agent writes a dashboard inside an ```openui-lang fence in its answer
 * (inline mode). Later answers in the chat change it with only the
 * statements that changed (edit mode), which merge into the one before.
 */

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'program'; code: string; complete: boolean };

const FENCE = /```openui-lang[^\n]*\n([\s\S]*?)(```|$)/g;

/** Splits an answer into prose and dashboard programs; an open fence is still streaming. */
export function splitAnswer(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(at, match.index);
    if (before.trim()) segments.push({ kind: 'text', text: before });
    segments.push({ kind: 'program', code: match[1] ?? '', complete: match[2] === '```' });
    at = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(at);
  if (rest.trim()) segments.push({ kind: 'text', text: rest });
  return segments;
}

export const hasProgram = (text: string) => text.includes('```openui-lang');

/** The dashboard after a patch: the patch merged into the program before it, if any. */
export function applyPatch(base: string | null, patch: string): string {
  if (!base) return patch.trim();
  return mergeStatements(base, patch);
}

/** The dashboard after every program in `texts`, in order, starting from `base`. */
export function programAfter(base: string | null, texts: string[]): string | null {
  let program = base;
  for (const text of texts) {
    if (!hasProgram(text)) continue;
    for (const segment of splitAnswer(text))
      if (segment.kind === 'program' && segment.code.trim())
        program = applyPatch(program, segment.code);
  }
  return program;
}
