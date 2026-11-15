import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CategoryColor } from './colors.js';

// The diagram's light half: its types, line ends and legend. The canvas
// itself (React Flow and dagre) is in diagram.tsx and loads only when shown.

export interface DiagramRow {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Short text on the right: a type or what a relation links to. */
  detail?: string;
  /** Marks the row that names the node's records. */
  isKey?: boolean;
}

export interface DiagramNode {
  id: string;
  icon: LucideIcon;
  label: string;
  color?: CategoryColor;
  meta?: string;
  rows: DiagramRow[];
  /**
   * How the card reads: a record object (the default), an event type, or a
   * stand-in for "any record" that links can end on.
   */
  variant?: 'entity' | 'event' | 'any';
}

/** An end of a link: a node, and the row it attaches to (the header when there is none). */
export interface DiagramEnd {
  node: string;
  row?: string;
}

/** A link from a "many" end to the "one" end it points at. */
export interface DiagramEdge {
  id: string;
  from: DiagramEnd;
  to: DiagramEnd;
  /** The end at `to`: "one" unless both ends are many (many-to-many). */
  toEnd?: 'many' | 'one';
  /** The link in a sentence, the line's accessible name. */
  description: string;
  /** A dashed line: a built-in link rather than a relation field (an event's `about`). */
  dashed?: boolean;
}

/** Crow's foot, drawn pointing along +x with its prongs at x = 12 (the node). */
export const MANY_PATH = 'M0 6 L12 0 M0 6 L12 12 M0 6 L12 6';
/** A bar across the line, 7px from the node at x = 12. */
export const ONE_PATH = 'M5 0 L5 12';

/** Stroke of a line and its ends, highlighted or not. */
export const lineStroke = (lit: boolean) => ({
  stroke: lit ? 'var(--color-primary)' : 'var(--color-muted-foreground)',
  strokeWidth: lit ? 1.6 : 1.25,
});

/** A dashed line, as the diagram draws an event's `about` link, for a legend. */
export function DiagramDashedKey({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden width={28} height={14} viewBox="0 0 28 14" fill="none" stroke="currentColor">
        <path d="M2 7 H26" strokeWidth={1.25} strokeDasharray="4 3" />
      </svg>
      {children}
    </span>
  );
}

/** The two line ends, drawn the way the diagram draws them, for a legend. */
export function DiagramKey({ end, children }: { end: 'many' | 'one'; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden width={28} height={14} viewBox="0 0 28 14" fill="none" stroke="currentColor">
        <path d="M2 7 H26" strokeWidth={1.25} />
        {/* The node is on the left, so draw the end mirrored: x = 12 lands at x = 2. */}
        <path
          d={end === 'many' ? MANY_PATH : ONE_PATH}
          transform="translate(14 1) scale(-1 1)"
          strokeWidth={1.25}
          strokeLinecap="round"
        />
      </svg>
      {children}
    </span>
  );
}
