import {
  canGroupBy,
  canPlaceBy,
  type FieldView,
  isInverseRelation,
  type ObjectView,
  type SavedView,
  type SavedViewKind,
  type UpdateViewInput,
} from '@retainer/shared';
import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { encodeFilter, parseColumnPrefs, parseListSearch } from './list-state.js';

// ---------------------------------------------------------------------------
// A saved view and the URL: the URL's `filter` and `sort` are unsaved changes
// on top of the view. `{}` and `[]` mean "none", where the view has some.
// ---------------------------------------------------------------------------

export type ListOverrides = { filter?: string; sort?: string };

/** The filter and sort the screen runs: the URL's where it has its own, else the view's. */
export function effectiveSearch(saved: SavedView | undefined, search: ListOverrides) {
  const filter = search.filter ?? (saved?.filter ? JSON.stringify(saved.filter) : undefined);
  const sort = search.sort ?? (saved?.sort ? JSON.stringify(saved.sort) : undefined);
  return {
    filter: filter === '{}' ? undefined : filter,
    sort: sort === '[]' ? undefined : sort,
  };
}

/**
 * A filter as the chips would write it, so equal filters compare equal. An
 * address that isn't valid JSON reads as no filter; the list reports it.
 */
const normalRaw = (raw: string | undefined) =>
  raw ? (encodeFilter(parseListSearch({ filter: raw })) ?? '') : '';
const normalFilter = (filter: Record<string, unknown> | null | undefined) =>
  filter ? normalRaw(JSON.stringify(filter)) : '';
const normalSort = (sort: SavedView['sort']) => (sort?.length ? JSON.stringify(sort) : '');

/**
 * The URL `filter` for a change: none when it matches the saved view (so
 * returning to it clears the change), `{}` when the view has a filter and
 * the change removes it.
 */
export function filterParam(next: string | undefined, saved: SavedView | undefined) {
  if (!saved) return next;
  if ((next ?? '') === normalFilter(saved.filter)) return undefined;
  return next ?? '{}';
}
export function sortParam(next: string | undefined, saved: SavedView | undefined) {
  if (!saved) return next;
  if ((next ?? '') === normalSort(saved.sort)) return undefined;
  return next ?? '[]';
}

/** Whether the URL changes the saved view's filter or sort. */
export function hasChanges(saved: SavedView | undefined, search: ListOverrides): boolean {
  if (!saved) return false;
  const { filter, sort } = effectiveSearch(saved, search);
  return (
    (search.filter !== undefined && normalRaw(filter) !== normalFilter(saved.filter)) ||
    (search.sort !== undefined && (sort ?? '') !== normalSort(saved.sort))
  );
}

/** The changes as a view update: what to save, with `null` for "none" (or invalid). */
export function changesToSave(saved: SavedView, search: ListOverrides) {
  const { query } = parseListSearch(effectiveSearch(saved, search));
  return { filter: query.filter ?? null, sort: query.sort ?? null };
}

/** A view's columns as the grid's column preferences. */
export const viewColumns = (saved: SavedView) => parseColumnPrefs(saved.columns);

/** The query key of an object's saved views. */
export const viewsKey = (workspace: string, object: string) => [workspace, 'views', object];

/**
 * Overlapping saves of one view can finish in any order, and the server
 * merges them under a row lock, so no single reply is known to be the final
 * state. As each save settles this says what to do: wait for the rest, use a
 * lone save's reply, or read the views again once the last of several (or
 * after a failure) is done.
 */
export class ViewSaves {
  private count = 0;
  private overlapped = false;
  start(): void {
    if (this.count > 0) this.overlapped = true;
    this.count++;
  }
  settle(ok: boolean): 'wait' | 'use' | 'refetch' {
    this.count--;
    if (!ok) this.overlapped = true;
    if (this.count > 0) return 'wait';
    const next = this.overlapped ? 'refetch' : 'use';
    this.overlapped = false;
    return next;
  }
}

/** A view change as it will read back, shown before the server answers. */
export function applyChange(view: SavedView, change: UpdateViewInput): SavedView {
  const next = { ...view } as Record<string, unknown>;
  for (const [key, value] of Object.entries(change))
    if (value !== undefined) next[key] = key === 'hiddenGroups' ? (value ?? []) : value;
  return next as SavedView;
}

export const KIND_LABELS: Record<SavedViewKind, string> = {
  table: 'Table',
  board: 'Board',
  calendar: 'Calendar',
};

/** What a board or calendar needs: the field it is laid out by. */
export const LAYOUT_FIELDS = {
  board: {
    setting: 'groupBy',
    label: 'Group by',
    hint: 'Each group becomes a column',
    fits: (field: FieldView) =>
      canGroupBy(field) ||
      (field.type === 'relation' &&
        field.isFilterable &&
        !isInverseRelation(field) &&
        field.settings.relationCardinality === 'many_to_one'),
    choose: 'Choose the field whose options become columns',
    none: (plural: string) => `${plural} have no select or single relation to group by`,
    removed: 'The field this board was grouped by was removed, or can no longer group it. ',
    prompt: 'Choose a select or single relation to group the board by.',
  },
  calendar: {
    setting: 'dateField',
    label: 'Date field',
    hint: 'Records sit on this date',
    fits: canPlaceBy,
    choose: 'Choose the date field to place records by',
    none: (plural: string) => `${plural} have no date field to place on a calendar`,
    removed: 'The date field this calendar was placed by was removed, or can no longer place it. ',
    prompt: 'Choose a date field to place records on the calendar.',
  },
} as const;
export type FieldLayout = keyof typeof LAYOUT_FIELDS;

/** The fields a board or calendar can be laid out by. */
export const layoutFields = (object: ObjectView, kind: FieldLayout) =>
  object.fields.filter(LAYOUT_FIELDS[kind].fits);

/** ANDs a condition onto a filter that may be absent. */
export function andFilter(
  filter: Record<string, unknown> | undefined,
  condition: Record<string, unknown>,
): Record<string, unknown> {
  return filter && Object.keys(filter).length ? { and: [filter, condition] } : condition;
}

// ---------------------------------------------------------------------------
// Board columns: the group field's options as they are now, then "No value".
// ---------------------------------------------------------------------------

/** A board column: one of the field's options, or records with no value. */
export type BoardGroup = { key: string; value: string | null; label: string };

export const groupKey = (value: string | null) => (value === null ? 'none' : `v:${value}`);

/**
 * Every record has a column: the schema engine won't remove an option
 * records hold, or make a field required while records lack it (3).
 */
export function boardGroups(field: FieldView): BoardGroup[] {
  return [
    ...(field.settings.options ?? []).map((o) => ({
      key: groupKey(o.value),
      value: o.value,
      label: o.label,
    })),
    ...(field.isNullable
      ? [{ key: groupKey(null), value: null, label: `No ${field.label.toLowerCase()}` }]
      : []),
  ];
}

/** The condition that puts a record in a column. */
export const groupCondition = (field: FieldView, value: string | null) =>
  value === null ? { [field.name]: { isNull: true } } : { [field.name]: { eq: value } };

export function toggleHidden(hidden: readonly (string | null)[], value: string | null) {
  return hidden.includes(value) ? hidden.filter((v) => v !== value) : [...hidden, value];
}

// ---------------------------------------------------------------------------
// Calendar: a month as whole weeks, and how a record's date maps to a day.
// ---------------------------------------------------------------------------

export const DAY = 'yyyy-MM-dd';

/** The first day of the week where the viewer is (0 Sunday … 6 Saturday). */
export function weekStartsOn(locale = navigator.language): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  try {
    // `getWeekInfo()` in current browsers, the `weekInfo` getter in older ones.
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    // `firstDay` counts Monday as 1 and Sunday as 7.
    if (info) return (info.firstDay % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  } catch {
    /* An unknown locale falls back to Sunday. */
  }
  return 0;
}

/** `?month=2026-11`; anything else is this month. */
export function parseMonth(raw: string | undefined, today = new Date()): Date {
  const parsed = raw ? parse(raw, 'yyyy-MM', today) : undefined;
  return startOfMonth(parsed && isValid(parsed) ? parsed : today);
}
export const monthParam = (month: Date) => format(month, 'yyyy-MM');

/** Every day shown for a month: whole weeks, from the week of the 1st to the week of the last. */
export function monthDays(month: Date, startsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6): Date[] {
  return eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: startsOn }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: startsOn }),
  });
}

/** The condition that finds records from the first to the last day shown. */
export function rangeCondition(field: FieldView, first: Date, last: Date) {
  if (field.type === 'date')
    return { [field.name]: { gte: format(first, DAY), lte: format(last, DAY) } };
  // Date-times from local midnight of the first day to local midnight after the last.
  return {
    [field.name]: { gte: first.toISOString(), lt: addDays(last, 1).toISOString() },
  };
}

/** The local day a value falls on, as `yyyy-MM-dd`. */
export function dayOf(field: FieldView, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (field.type === 'date') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : format(date, DAY);
}

/** A value moved to another day; a date-time keeps its local time of day. */
export function movedTo(field: FieldView, value: string, day: string): string {
  if (field.type === 'date') return day;
  const from = new Date(value);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const to = new Date(from);
  to.setFullYear(y, m - 1, d);
  return to.toISOString();
}

/** "9:30 AM": an instant's local clock time. */
export const clockTime = (at: string | Date) =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "9:30 AM" for a date-time; nothing for a date. */
export function timeOf(field: FieldView, value: unknown): string | undefined {
  if (field.type !== 'date_time' || typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : clockTime(date);
}
