import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  QueryInput,
  RecordPage,
  SavedView,
} from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { addMonths, format, isSameMonth, isToday, subMonths } from 'date-fns';
import { useMemo } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import {
  CalendarDay,
  CalendarEntry,
  CalendarHeader,
  calendarEntryLabel,
  DragArea,
  EntryPreview,
  Inset,
  MonthGrid,
  MoreEntries,
  Notice,
} from '../../ui/index.js';
import { recordCategory } from '../../ui/record-colors.js';
import { isEventColumn, withEventValues } from '../events/event-list.js';
import { useRecordMoves } from '../records/record-move.js';
import { isWritable } from '../records/write-model.js';
import { QueryError, recordTitle } from '../state.js';
import { MissingLayoutField } from './view-bar.js';
import {
  andFilter,
  DAY,
  dayOf,
  monthDays,
  monthParam,
  movedTo,
  parseMonth,
  rangeCondition,
  timeOf,
  weekStartsOn,
} from './views-state.js';

/** Records shown per day before "n more". */
const PER_DAY = 3;
/** A month loads in pages of the largest size the API allows, up to this many records. */
const PAGE_SIZE = 200;
const MAX_RECORDS = 1000;

/**
 * A month calendar: the view's records placed on the day of its date field,
 * the filter applied, a month at a time (`?month=`). Dragging a record to
 * another day changes its date; a date-time keeps its time of day.
 */
export function CalendarView({
  object,
  view,
  filter,
  search,
  sort,
  month: monthRaw,
  writable,
  selected,
  onOpen,
  onMonth,
  onChangeView,
}: {
  object: ObjectView;
  view: SavedView;
  filter: Record<string, unknown> | undefined;
  search?: string;
  sort: QueryInput['sort'];
  month: string | undefined;
  /** Can write: records can be moved, and the view changed. */
  writable: boolean;
  selected: string | undefined;
  onOpen: (id: string) => void;
  onMonth: (month: string | undefined) => void;
  onChangeView: (change: { dateField: string }) => void;
}) {
  const { session } = useWorkspace();
  const name = object.nameSingular;
  const field = object.fields.find((f) => f.name === view.dateField);
  const moves = useRecordMoves<{ record: PresentedRecord }>();
  const month = useMemo(() => parseMonth(monthRaw), [monthRaw]);
  const days = useMemo(() => monthDays(month, weekStartsOn()), [month]);
  const first = days[0] as Date,
    last = days[days.length - 1] as Date;

  const input: QueryInput | undefined = field
    ? {
        search,
        filter: andFilter(filter, rangeCondition(field, first, last)),
        // Within a day: the view's order, or by the date itself.
        sort: sort?.length ? sort : [{ field: field.name, direction: 'asc' }],
        limit: PAGE_SIZE,
      }
    : undefined;
  const query = useQuery({
    queryKey: [session.workspace.id, 'records', name, 'calendar', input],
    queryFn: ({ signal }) => loadMonth(name, input as QueryInput, signal),
    enabled: !!input,
    placeholderData: (previous) => previous,
  });
  const undated = useQuery({
    queryKey: [session.workspace.id, 'aggregate', name, 'undated', filter, search, field?.name],
    queryFn: ({ signal }) =>
      api.aggregate(
        name,
        { search, filter: andFilter(filter, { [field?.name as string]: { isNull: true } }) },
        signal,
      ),
    // An event's time is never empty, and the totals route doesn't take built-in columns.
    enabled: !!field && !(isEventColumn(field.name) && field.readOnly),
  });

  // Where a record shows: where it is moving to, while that saves.
  const { shownValue } = moves;
  const byDay = useMemo(() => {
    const map = new Map<string, PresentedRecord[]>();
    if (!field) return map;
    for (const record of query.data?.records ?? []) {
      const day = dayOf(field, shownValue(record, field.name));
      if (!day) continue;
      const list = map.get(day);
      if (list) list.push(record);
      else map.set(day, [record]);
    }
    return map;
  }, [query.data, field, shownValue]);

  if (!field)
    return (
      <MissingLayoutField
        object={object}
        view={view}
        kind="calendar"
        writable={writable}
        onChoose={(dateField) => onChangeView({ dateField })}
      />
    );

  const draggable = writable && isWritable(field);
  const dayLabel = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  /** The label of a `yyyy-MM-dd` day, read at noon so no time zone moves it. */
  const keyLabel = (day: string) => dayLabel(new Date(`${day}T12:00:00`));
  const dateValue = (r: PresentedRecord) => shownValue(r, field.name);
  const undatedCount = undated.data?.total ?? 0;

  /** A record on its day, or in the day's "more" panel; both can be moved. */
  const entry = (r: PresentedRecord, day: string, inPanel: boolean) => (
    <CalendarEntry
      key={r.id}
      // The panel lists the day's first records too, so its entries drag under ids of their own.
      id={inPanel ? `panel:${r.id}` : r.id}
      day={day}
      item={r}
      title={recordTitle(r)}
      time={timeOf(field, dateValue(r))}
      category={recordCategory(object, r)}
      // One move at a time: a record saving its move can't be moved again.
      draggable={draggable && !Object.hasOwn(moves.moving, r.id)}
      selected={selected === r.id}
      pending={Object.hasOwn(moves.moving, r.id)}
      inPanel={inPanel}
      onOpen={() => onOpen(r.id)}
    />
  );

  return (
    <>
      <CalendarHeader
        title={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        onPrevious={() => onMonth(monthParam(subMonths(month, 1)))}
        onNext={() => onMonth(monthParam(addMonths(month, 1)))}
        onToday={() => onMonth(undefined)}
      >
        {query.isFetching && query.data ? <span>Updating…</span> : null}
        {undatedCount ? (
          <span>
            {undatedCount.toLocaleString()} without {articled(field)}
          </span>
        ) : null}
      </CalendarHeader>
      {moves.notice || query.error || query.data?.truncated ? (
        <Inset>
          {moves.notice ? (
            <Notice error={moves.notice.error} onDismiss={moves.dismiss}>
              {moves.notice.text}
            </Notice>
          ) : null}
          {query.error ? (
            <QueryError error={query.error} retry={() => void query.refetch()} />
          ) : null}
          {query.data?.truncated ? (
            <Notice>
              Showing the first {MAX_RECORDS.toLocaleString()} records of this month. Add a filter
              to see the rest.
            </Notice>
          ) : null}
        </Inset>
      ) : null}
      <DragArea<PresentedRecord>
        names={{
          item: (record) =>
            calendarEntryLabel(
              recordTitle(record),
              timeOf(field, dateValue(record)),
              recordCategory(object, record).label,
            ),
          target: keyLabel,
        }}
        overlay={(record) => (
          <EntryPreview
            title={recordTitle(record)}
            time={timeOf(field, dateValue(record))}
            category={recordCategory(object, record)}
          />
        )}
        onMove={(record, day) => {
          const value = record.fields[field.name];
          if (typeof value === 'string')
            void moves.move({ record }, field, movedTo(field, value, day), keyLabel(day));
        }}
      >
        <MonthGrid
          label={`${object.labelPlural} by ${field.label.toLowerCase()}`}
          weekdays={days
            .slice(0, 7)
            .map((d) => d.toLocaleDateString(undefined, { weekday: 'short' }))}
        >
          {days.map((d) => {
            const key = format(d, DAY);
            const list = byDay.get(key) ?? [];
            // A day fits PER_DAY records, or one fewer and the "more" button.
            const visible = list.length > PER_DAY ? list.slice(0, PER_DAY - 1) : list;
            const rest = list.slice(visible.length);
            return (
              <CalendarDay
                key={key}
                id={key}
                label={dayLabel(d)}
                day={d.getDate()}
                outside={!isSameMonth(d, month)}
                today={isToday(d)}
                locked={!draggable}
                more={
                  rest.length ? (
                    <MoreEntries
                      title={dayLabel(d)}
                      hiddenRecordIds={rest.map((record) => record.id)}
                    >
                      {list.map((r) => entry(r, key, true))}
                    </MoreEntries>
                  ) : null
                }
              >
                {visible.map((r) => entry(r, key, false))}
              </CalendarDay>
            );
          })}
        </MonthGrid>
      </DragArea>
    </>
  );
}

/** "a close date", "an end date". */
const articled = (field: FieldView) =>
  `${/^[aeiou]/i.test(field.label) ? 'an' : 'a'} ${field.label.toLowerCase()}`;

/** Every record in the range, a page at a time, up to `MAX_RECORDS`. */
async function loadMonth(
  object: string,
  input: QueryInput,
  signal: AbortSignal,
): Promise<{ records: PresentedRecord[]; truncated: boolean }> {
  const records: PresentedRecord[] = [];
  let page: RecordPage | undefined;
  do {
    page = await api.queryRecords(
      object,
      page?.nextCursor ? { ...input, cursor: page.nextCursor } : input,
      signal,
    );
    // An event type's calendar may be placed by when its events happened.
    records.push(...page.records.map(withEventValues));
  } while (page.nextCursor && records.length < MAX_RECORDS);
  return { records, truncated: !!page.nextCursor };
}
