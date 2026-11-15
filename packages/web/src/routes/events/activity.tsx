import type { EventRecord, FieldView, RecordReference } from '@retainer/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListFilter } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { FieldPicker } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import { objectColor } from '../../ui/colors.js';
import {
  ApiName,
  Badge,
  Button,
  Code,
  Empty,
  FeedDay,
  FeedItem,
  FeedLinks,
  FeedScroll,
  FilterChip,
  Form,
  FormField,
  Input,
  Inset,
  Muted,
  Notice,
  OptionList,
  objectIcon,
  Page,
  PanelBody,
  PanelHeader,
  Popover,
  Toolbar,
  toggleValue,
} from '../../ui/index.js';
import { ApiLabel, useApiName, useDeveloper } from '../developer.js';
import { RecordSheet } from '../records/record-view.js';
import {
  eventTitle,
  objectByName,
  objectLabel,
  QueryError,
  recordTitle,
  sortObjects,
  useRecordLabel,
  useView,
} from '../state.js';
import { clockTime } from '../views/views-state.js';
import {
  type FeedFilters,
  feedQuery,
  feedSearch,
  filterCount,
  groupByDay,
  parseFeedSearch,
  rangeText,
} from './activity-state.js';
import { eventColumnField, eventMedium, ParticipantsCell } from './event-list.js';

/**
 * Everything logged in the workspace, newest first, read by day
 * (`POST /v1/events/query`). Filters live in the address only; a row opens
 * the event in the side sheet, as record lists do.
 */
export function ActivityPage() {
  const { session, schema } = useWorkspace(),
    { search, setSearch } = useView(),
    developer = useDeveloper();
  const filters = parseFeedSearch(
    search,
    schema.objects.filter((o) => o.class === 'event').map((o) => o.nameSingular),
  );
  const input = feedQuery(filters);
  const feed = useInfiniteQuery({
    queryKey: [session.workspace.id, 'events', 'feed', input],
    queryFn: ({ pageParam, signal }) =>
      api.queryEvents(pageParam ? { ...input, cursor: pageParam } : input, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const events = useMemo(() => feed.data?.pages.flatMap((p) => p.records) ?? [], [feed.data]);
  const references = useMemo(
    () =>
      Object.assign(
        {},
        ...(feed.data?.pages.map((p) => p.relationReferences ?? {}) ?? []),
      ) as Record<string, RecordReference>,
    [feed.data],
  );
  const days = useMemo(() => groupByDay(events), [events]);
  const anyEntity = useMemo(() => eventColumnField(schema, 'about'), [schema]);
  const openEvent = useCallback((id: string) => void setSearch({ record: id }), [setSearch]);
  const setFilters = (next: FeedFilters) =>
    void setSearch({ ...feedSearch(next), record: undefined });
  const count = filterCount(filters);

  return (
    <Page layout="fill" eyebrow="Activity" title="All activity">
      <Toolbar
        end={
          count > 1 ? (
            <Button variant="ghost" size="small" onClick={() => setFilters({ types: [] })}>
              Clear filters
            </Button>
          ) : null
        }
      >
        {filters.types.length ? (
          <FilterChip
            field="Type"
            operator={filters.types.length > 1 ? 'is any of' : 'is'}
            value={filters.types.map((t) => objectLabel(schema, t)).join(', ')}
            onRemove={() => setFilters({ ...filters, types: [] })}
          />
        ) : null}
        {filters.channel ? (
          <FilterChip
            field="Source"
            operator="is"
            value={filters.channel}
            onRemove={() => setFilters({ ...filters, channel: undefined })}
          />
        ) : null}
        {filters.from || filters.to ? (
          <FilterChip
            field="Date"
            value={rangeText(filters.from, filters.to)}
            onRemove={() => setFilters({ ...filters, from: undefined, to: undefined })}
          />
        ) : null}
        {filters.linked ? (
          <LinkedChip
            id={filters.linked}
            references={references}
            onRemove={() => setFilters({ ...filters, linked: undefined })}
          />
        ) : null}
        <FeedFilterMenu filters={filters} anyEntity={anyEntity} onChange={setFilters} />
      </Toolbar>
      {feed.error ? (
        <Inset>
          <QueryError error={feed.error} retry={() => void feed.refetch()} />
        </Inset>
      ) : null}
      {feed.isPending ? (
        <Inset>
          <Notice>Loading activity…</Notice>
        </Inset>
      ) : !events.length && feed.data ? (
        <Inset>
          <Empty
            title={count ? 'No activity matches these filters' : 'No activity yet'}
            description={
              count
                ? 'Remove a filter to see more.'
                : 'Meetings, calls, emails and notes your agents log show up here, newest first.'
            }
          />
        </Inset>
      ) : (
        <FeedScroll>
          {days.map((d) => (
            <FeedDay key={d.day} heading={d.heading}>
              {d.events.map((e) => (
                <ActivityItem
                  key={e.id}
                  event={e}
                  references={references}
                  anyEntity={anyEntity}
                  developer={developer}
                  selected={search.record === e.id}
                  onOpen={openEvent}
                />
              ))}
            </FeedDay>
          ))}
          {feed.hasNextPage ? (
            <Button disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : events.length ? (
            <Muted small>That’s everything.</Muted>
          ) : null}
        </FeedScroll>
      )}
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

/** One event in the feed: its type, medium, title, summary, who and what it involves, and when. */
const ActivityItem = memo(function ActivityItem({
  event: e,
  references,
  anyEntity,
  developer,
  selected,
  onOpen,
}: {
  event: EventRecord;
  references: Record<string, RecordReference>;
  anyEntity: FieldView;
  developer: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const { schema } = useWorkspace();
  const type = objectByName(schema, e.type);
  const medium = eventMedium(type, e);
  const Display = fields.relation.Display;
  const { matched, unmatched } = e.event.participants;
  return (
    <FeedItem
      icon={objectIcon(e.type, 'event')}
      iconLabel={type?.labelSingular ?? e.type}
      color={objectColor(e.type)}
      title={eventTitle(e.event)}
      chips={
        <>
          {medium ? <Badge>{medium}</Badge> : null}
          <ApiLabel name={e.type} />
        </>
      }
      time={clockTime(e.event.occurredAt)}
      summary={e.event.summary}
      selected={selected}
      onOpen={() => onOpen(e.id)}
      footer={
        <>
          {matched.length || unmatched.length ? (
            <FeedLinks label="With">
              <ParticipantsCell
                record={e}
                field={anyEntity}
                references={references}
                compact={false}
              />
            </FeedLinks>
          ) : null}
          {e.event.about.length ? (
            <FeedLinks label="About">
              <Display field={anyEntity} value={e.event.about} references={references} />
            </FeedLinks>
          ) : null}
          {developer ? (
            <>
              <Code>channel {JSON.stringify(e.event.channel)}</Code>
              <Code>externalId {JSON.stringify(e.event.externalId)}</Code>
            </>
          ) : null}
        </>
      }
    />
  );
});

/** "Linked to Acme": the record named from the page's references, or fetched. */
function LinkedChip({
  id,
  references,
  onRemove,
}: {
  id: string;
  references: Record<string, RecordReference>;
  onRemove: () => void;
}) {
  const known = references[id];
  const record = useRecordLabel(id, !known);
  const label = known ?? record.data;
  return (
    <FilterChip
      field="Linked to"
      value={label ? recordTitle(label) : record.error ? 'Unavailable record' : '…'}
      onRemove={onRemove}
    />
  );
}

type Step = 'type' | 'channel' | 'date' | 'linked';
const STEPS: { value: Step; label: string }[] = [
  { value: 'type', label: 'Type' },
  { value: 'channel', label: 'Source' },
  { value: 'date', label: 'Date' },
  { value: 'linked', label: 'Linked record' },
];

/** Adds a filter: first what to filter by, then its value. */
function FeedFilterMenu({
  filters,
  anyEntity,
  onChange,
}: {
  filters: FeedFilters;
  anyEntity: FieldView;
  onChange: (next: FeedFilters) => void;
}) {
  const { schema } = useWorkspace(),
    apiName = useApiName();
  const [open, setOpen] = useState(false),
    [step, setStep] = useState<Step | null>(null),
    [channel, setChannel] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const types = sortObjects(schema.objects).filter((o) => o.class === 'event');
  const linkedField = useMemo<FieldView>(
    () => ({
      ...anyEntity,
      name: 'linked',
      label: 'Linked record',
      settings: { ...anyEntity.settings, relationCardinality: 'many_to_one' },
    }),
    [anyEntity],
  );
  function choose(next: Step) {
    setStep(next);
    setChannel(filters.channel ?? '');
    setFrom(filters.from ?? '');
    setTo(filters.to ?? '');
  }
  const close = () => {
    setOpen(false);
    setStep(null);
  };
  const header = (title: string) => (
    <PanelHeader
      title={title}
      back={{ label: 'Choose another filter', onClick: () => setStep(null) }}
    />
  );
  return (
    <Popover
      label="Filter activity"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setStep(null);
      }}
      trigger={
        <Button variant="ghost" size="small">
          <ListFilter size={14} />
          Filter
        </Button>
      }
    >
      {step === 'type' ? (
        <>
          {header('Type')}
          <OptionList
            label="Event types"
            multiple
            searchable={types.length > 7}
            options={types.map((t) => {
              const name = apiName(t.nameSingular);
              return {
                value: t.nameSingular,
                label: t.labelPlural,
                ...(name
                  ? {
                      content: (
                        <>
                          {t.labelPlural}
                          <ApiName>{name}</ApiName>
                        </>
                      ),
                      keywords: name,
                    }
                  : {}),
              };
            })}
            selected={filters.types}
            onPick={(t) => onChange({ ...filters, types: toggleValue(filters.types, t) })}
          />
        </>
      ) : step === 'channel' ? (
        <>
          {header('Source')}
          <PanelBody>
            <Form
              autoFocus
              onSubmit={() => {
                onChange({ ...filters, channel: channel.trim() || undefined });
                close();
              }}
            >
              <FormField label="Source is" apiName={apiName('channel')}>
                <Input
                  aria-label="Source"
                  placeholder="gmail, zoom, web…"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                />
              </FormField>
              <Button type="submit" variant="primary">
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : step === 'date' ? (
        <>
          {header('Date')}
          <PanelBody>
            <Form
              autoFocus
              onSubmit={() => {
                onChange({ ...filters, from: from || undefined, to: to || undefined });
                close();
              }}
            >
              <FormField label="From" apiName={apiName('occurredAt')}>
                <Input
                  aria-label="From"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </FormField>
              <FormField label="To">
                <Input
                  aria-label="To"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </FormField>
              <Button type="submit" variant="primary" disabled={!from && !to}>
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : step === 'linked' ? (
        <>
          {header('Linked record')}
          <FieldPicker
            field={linkedField}
            value={filters.linked ?? null}
            onChange={(id) => {
              onChange({ ...filters, linked: typeof id === 'string' && id ? id : undefined });
              close();
            }}
          />
        </>
      ) : (
        <OptionList
          label="Filter by"
          searchable={false}
          options={STEPS}
          onPick={(s) => choose(s as Step)}
        />
      )}
    </Popover>
  );
}
