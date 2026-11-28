import { type RoutineDraft, type RoutineReport, routineReportSchema } from '@retainer/shared';

/**
 * A `retainer-routine` fence (routines-in-chat spec §4.2): only what the
 * agent wrote, and the IDs of what Retainer checked. Everything Retainer
 * vouches for (facts, code, count, dry run) is read from the draft route.
 */
export type RoutineFence = {
  source: string;
  preview: string | null;
  name: string;
  description: string;
  summary: string;
  report: RoutineReport;
  routine?: string;
};

const KEYS = new Set(['source', 'preview', 'name', 'description', 'summary', 'report', 'routine']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { name: 200, description: 10000, summary: 500 } as const;

const text = (value: unknown, key: keyof typeof LIMITS) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The draft needs a ${key}.`);
  if (value.trim().length > LIMITS[key]) throw new Error(`The draft's ${key} is too long.`);
  return value.trim();
};

function report(value: unknown): RoutineReport {
  if (!value || typeof value !== 'object') throw new Error('The draft needs a report.');
  if ((value as { verdict?: unknown }).verdict === 'not_possible')
    throw new Error('A routine that is not possible has no draft to propose.');
  // The same schema Propose checks, so a card never offers what Propose refuses.
  const parsed = routineReportSchema.safeParse(value);
  if (!parsed.success) throw new Error('The report’s verdict or gaps are not valid.');
  return parsed.data;
}

/** Parses a fence, refusing unknown keys, missing keys and a not-possible verdict. */
export function parseRoutineFence(raw: string): RoutineFence {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The draft must be a JSON object.');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new Error(`The draft has keys it should not: ${unknown.join(', ')}.`);
  if (typeof record.source !== 'string' || !ID.test(record.source))
    throw new Error('The draft must name its checked source.');
  if (!('preview' in record)) throw new Error('The draft must say which dry run it has.');
  if (record.preview !== null && (typeof record.preview !== 'string' || !ID.test(record.preview)))
    throw new Error('The draft’s preview must be an ID or null.');
  if (
    record.routine !== undefined &&
    (typeof record.routine !== 'string' || !ID.test(record.routine))
  )
    throw new Error('The draft’s routine must be an ID.');
  return {
    source: record.source,
    preview: record.preview as string | null,
    name: text(record.name, 'name'),
    description: text(record.description, 'description'),
    summary: text(record.summary, 'summary'),
    report: report(record.report),
    ...(record.routine ? { routine: record.routine as string } : {}),
  };
}

/** The propose body for a fence: the source by ID, never the code (§5.3). */
export function proposeBody(fence: RoutineFence) {
  return {
    sourceId: fence.source,
    name: fence.name,
    description: fence.description,
    summary: fence.summary,
    report: fence.report,
    ...(fence.routine ? { routineId: fence.routine } : {}),
  };
}

const sameReport = (a: RoutineReport, b: RoutineReport) =>
  a.verdict === b.verdict &&
  a.gaps.length === b.gaps.length &&
  a.gaps.every(
    (gap, i) =>
      gap.part === b.gaps[i]?.part &&
      gap.reason === b.gaps[i]?.reason &&
      gap.fix === b.gaps[i]?.fix,
  );

/**
 * The proposal this card made, if the person made it (§5.3): same source,
 * proposed by the viewer, the same words and the same target. The source
 * alone is not enough: a draft that changed only its name shares it.
 */
export function matchingProposal(fence: RoutineFence, proposals: RoutineDraft['proposals']) {
  return proposals.findLast(
    (proposal) =>
      proposal.byYou &&
      proposal.name === fence.name &&
      proposal.description === fence.description &&
      proposal.summary === fence.summary &&
      sameReport(proposal.report, fence.report) &&
      (fence.routine ? proposal.routineId === fence.routine : proposal.number === 1),
  );
}

export type DraftState =
  | { kind: 'proposed'; proposal: RoutineDraft['proposals'][number] }
  | { kind: 'problems' }
  | { kind: 'unchecked' }
  | { kind: 'ready' };

/** The card's state, tested in the order of spec §5.2. Expired is a 404 before this. */
export function draftState(fence: RoutineFence, draft: RoutineDraft): DraftState {
  const proposal = matchingProposal(fence, draft.proposals);
  if (proposal) return { kind: 'proposed', proposal };
  if (draft.problems.length) return { kind: 'problems' };
  if (!draft.ok) return { kind: 'unchecked' };
  return { kind: 'ready' };
}

/** The count line, worded by trigger (§5.1). */
export function countText(count: RoutineDraft['count']): string | null {
  if (!count) return null;
  const n = count.value ?? 0;
  switch (count.kind) {
    case 'record':
      return `${n.toLocaleString()} ${n === 1 ? 'change' : 'changes'} in the last 30 days matched the trigger, before its condition.`;
    case 'schedule':
      return `${n.toLocaleString()} ${n === 1 ? 'record matches' : 'records match'} now, before the limit on one run.`;
    case 'schedule_once':
      return 'Runs once each time, without a record.';
    default:
      return null;
  }
}

/** The words for a matched proposal's state (§5.3). */
export function proposalText(state: RoutineDraft['proposals'][number]['state']) {
  switch (state) {
    case 'approved':
      return 'Approved. It runs as the approved version.';
    case 'rejected':
      return 'Rejected by an admin. Ask the agent for a changed draft.';
    case 'superseded':
      return 'Replaced by a newer version.';
    default:
      return 'Proposed, waiting for an admin. Nothing runs until an admin approves it.';
  }
}

const DAY_MS = 86_400_000;
/** Stored results are cleared 7 days after a run ends (routines spec §6.6). */
export const KEPT_DAYS = 7;

/**
 * How old a stored dry run is. Retention clears each run 7 days after it
 * finished, so the dry run is gone only once its newest run is; a run still
 * going counts as now.
 */
export function previewAge(runs: readonly { finishedAt: string | null }[], now = Date.now()) {
  const ended = runs.map((run) => (run.finishedAt ? Date.parse(run.finishedAt) : now));
  const newest = ended.length ? Math.max(...ended) : undefined;
  const age = newest === undefined ? 0 : now - newest;
  return { age, newest, cleared: age > KEPT_DAYS * DAY_MS };
}
