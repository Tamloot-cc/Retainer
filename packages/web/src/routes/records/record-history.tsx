import { RetainerApiError } from '@retainer/sdk';
import type { ObjectView, TimelineItem } from '@retainer/shared';
import { isInverseRelation } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { PencilLine } from 'lucide-react';
import { api, useWorkspace } from '../../api/client.js';
import { fields as fieldModules } from '../../fields/index.js';
import { ActorBadge, SourceBadge } from '../../provenance/index.js';
import {
  Badge,
  Button,
  Code,
  Empty,
  Entry,
  EntryDay,
  EntryList,
  EntryLoading,
  EventLink,
  LoadMore,
  Muted,
  Notice,
  Row,
  SelectMenu,
  Stack,
} from '../../ui/index.js';
import { byCursor, eventTitle, joined, list, objectLabel, QueryError } from '../state.js';
import { clockTime } from '../views/views-state.js';

export type FieldChangeItem = Extract<TimelineItem, { kind: 'field_change' }>;

/**
 * Items in runs of the same local day, in the order given (newest first).
 * Pages are flattened before grouping, so a day split across two pages stays
 * one group.
 */
export function groupByDay(items: FieldChangeItem[]) {
  const days: { day: string; date: Date; items: FieldChangeItem[] }[] = [];
  for (const item of items) {
    const date = new Date(item.at);
    const day = format(date, 'yyyy-MM-dd');
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, date, items: [item] });
  }
  return days;
}

/** The values set on a record's fields, newest first, by day. */
export function RecordHistory({
  recordId,
  object,
  fields,
  onFieldsChange,
}: {
  recordId: string;
  /** The record's object: its fields to filter by and name. */
  object?: ObjectView;
  /** The fields to show, as a comma list from the address; none means all. */
  fields?: string;
  onFieldsChange: (fields: string | undefined) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const chosen = list(fields);
  const params = {
    types: ['field_change' as const],
    // Sorted, so the same fields are the same query however they were ticked.
    ...(chosen.length ? { fields: [...chosen].sort() } : {}),
  };
  // The filter is in the key: changing it starts again from the newest page.
  const queryKey = [session.workspace.id, 'timeline', recordId, params];
  const history = useInfiniteQuery({
    queryKey,
    queryFn: ({ signal, pageParam }) =>
      api.timeline(recordId, { ...params, cursor: pageParam, signal }),
    ...byCursor,
  });
  const items =
    history.data?.pages.flatMap((p) => p.items).filter((i) => i.kind === 'field_change') ?? [];
  const fieldOptions = (object?.fields ?? [])
    .filter((f) => !isInverseRelation(f))
    .map((f) => ({ value: f.name, label: f.label, keywords: f.name }));
  const staleCursor =
    history.error instanceof RetainerApiError && history.error.code === 'invalid_cursor';
  return (
    <Stack>
      <Row>
        <SelectMenu
          label="Fields"
          size="small"
          multiple
          placeholder="All fields"
          value={chosen}
          options={fieldOptions}
          onChange={(next) => onFieldsChange(joined(next))}
        />
        {chosen.length ? (
          <Button size="small" variant="ghost" onClick={() => onFieldsChange(undefined)}>
            Clear filters
          </Button>
        ) : null}
      </Row>
      {staleCursor ? (
        <Notice error>
          <Row>
            The history changed since this page was loaded.
            <Button onClick={() => void client.resetQueries({ queryKey })}>
              Start from the newest
            </Button>
          </Row>
        </Notice>
      ) : history.error ? (
        <QueryError error={history.error} retry={() => void history.refetch()} />
      ) : null}
      {history.isPending ? <EntryLoading label="Loading history…" /> : null}
      {history.data && !items.length ? (
        <Empty
          quiet
          title={chosen.length ? 'Nothing matches these filters' : 'No changes yet'}
          description="Values set on these fields appear here, newest first."
        />
      ) : null}
      {groupByDay(items).map((group) => (
        <section key={group.day}>
          <EntryDay>
            {group.date.toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </EntryDay>
          <EntryList label={`History for ${group.day}`}>
            {group.items.map((item) => (
              <FieldChange key={item.id} item={item} object={object} recordId={recordId} />
            ))}
          </EntryList>
        </section>
      ))}
      {history.hasNextPage ? (
        <LoadMore
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        />
      ) : null}
    </Stack>
  );
}

/**
 * "Stage set to Won". The value asserted, not a diff: a claim that is not
 * the current value may never have been the record's value, so it is
 * labelled and nothing says what it changed from.
 */
function FieldChange({
  item,
  object,
  recordId,
}: {
  item: FieldChangeItem;
  object?: ObjectView;
  /** The record whose history this is; a value from its own logging needs no "from". */
  recordId: string;
}) {
  const { schema } = useWorkspace();
  const field = object?.fields.find((f) => f.name === item.field);
  const module = field ? fieldModules[field.type] : null;
  const label = field?.label ?? item.field;
  // An event's own values cite the event: saying so on its page says nothing.
  const source = item.source && item.source.id !== recordId ? item.source : null;
  return (
    <Entry
      icon={PencilLine}
      title={
        <>
          {field && module ? (
            module.isEmpty(item.value) ? (
              <span>{label} cleared</span>
            ) : (
              <>
                <span>{label} set to</span>
                <module.Display
                  field={field}
                  value={item.value}
                  references={item.relationReferences}
                />
              </>
            )
          ) : (
            <>
              <span>{label} set to</span>
              <Code>{JSON.stringify(item.value)}</Code>
            </>
          )}
          {item.current ? null : <Badge>Not the current value</Badge>}
        </>
      }
      time={<time dateTime={item.at}>{clockTime(item.at)}</time>}
      footer={
        <>
          <ActorBadge actor={item.actor} />
          {item.confidence < 1 ? (
            <Muted small>Confidence {Math.round(item.confidence * 100)}%</Muted>
          ) : null}
          {source ? (
            <>
              <Muted small>from</Muted>
              <SourceBadge type={source.type} label={objectLabel(schema, source.type)} />
              <EventLink id={source.id}>
                {eventTitle(source)} · {new Date(source.occurredAt).toLocaleDateString()}
              </EventLink>
            </>
          ) : null}
        </>
      }
    />
  );
}
