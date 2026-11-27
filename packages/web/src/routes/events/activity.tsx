import type { RecordReference, WorkspaceFeedInput, WorkspaceFeedItem } from '@retainer/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type MouseEvent, useMemo, useRef, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { ActorBadge } from '../../provenance/index.js';
import {
  HomeCard,
  HomeChange,
  HomeDay,
  HomeScroll,
  HomeSummary,
  HomeTitle,
  HomeTools,
  HomeWelcome,
} from '../../ui/feed.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  EventLink,
  FilterChip,
  Input,
  Muted,
  Notice,
  Page,
  Row,
  Stack,
  Tabs,
} from '../../ui/index.js';
import { RecordSheet } from '../records/record-view.js';
import {
  byCursor,
  eventTitle,
  objectByName,
  objectLabel,
  QueryError,
  recordTitle,
  useDebounced,
  useRecordLabel,
  useView,
} from '../state.js';
import {
  dayHeading,
  feedQuery,
  feedSearch,
  filterCount,
  groupByDay,
  parseFeedSearch,
  rangeText,
} from './activity-state.js';
import { eventColumnField, ParticipantsCell } from './event-list.js';
import { FeedFilterMenu } from './feed-filters.js';

export function ActivityPage() {
  const { session, schema } = useWorkspace();
  const { search, setSearch } = useView();
  const client = useQueryClient();
  const [revertTarget, setRevertTarget] = useState<WorkspaceFeedItem | null>(null);
  const [reverted, setReverted] = useState(false);
  const revertTrigger = useRef<HTMLButtonElement | null>(null);
  const revertCancel = useRef<HTMLButtonElement | null>(null);
  const revertFeedback = useRef<HTMLDivElement | null>(null);
  const revert = useMutation({
    mutationFn: (item: WorkspaceFeedItem) =>
      api.revertFeedUpdate(item.id, {
        recordId: item.record.id,
        assertionIds: item.changes.map((change) => change.id),
      }),
    onSuccess: () => {
      setRevertTarget(null);
      setReverted(true);
      void client.invalidateQueries({ queryKey: [session.workspace.id] });
    },
  });
  const filters = parseFeedSearch(
    search,
    schema.objects.map((o) => o.nameSingular),
  );
  const mode = search.tab === 'events' || search.tab === 'records' ? search.tab : 'all';
  const query = useDebounced(search.q?.trim() ?? '');
  const input: WorkspaceFeedInput = {
    mode,
    ...feedQuery(filters),
    ...(query ? { query } : {}),
  };
  const feed = useInfiniteQuery({
    queryKey: [session.workspace.id, 'home-feed', input],
    queryFn: ({ pageParam, signal }) => api.workspaceFeed({ ...input, cursor: pageParam }, signal),
    ...byCursor,
    // A background refresh must not move cards while someone is reading.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const latest = useQuery({
    queryKey: [session.workspace.id, 'home-feed-latest', input],
    queryFn: ({ signal }) => api.workspaceFeed({ ...input, limit: 1 }, signal),
    refetchInterval: 30_000,
  });
  const review = useQuery({
    queryKey: [session.workspace.id, 'review', 'sidebar-count'],
    queryFn: ({ signal }) => api.review({ limit: 1, signal }),
  });
  const proposals = useQuery({
    queryKey: [session.workspace.id, 'schemaChanges', 'proposed', undefined],
    queryFn: ({ signal }) => api.schemaChanges({ status: 'proposed', limit: 50, signal }),
  });
  const totals = review.data?.totals;
  const reviewCount = totals
    ? totals.pendingAssertions +
      totals.mergeSuggestions +
      totals.unresolvedParticipants +
      (proposals.data?.total ?? 0)
    : 0;
  const days = useMemo(
    () => groupByDay(feed.data?.pages.flatMap((page) => page.items) ?? []),
    [feed.data],
  );
  const references = Object.assign(
    {},
    ...(feed.data?.pages.map((p) => p.references) ?? []),
  ) as Record<string, RecordReference>;
  const first = feed.data?.pages[0]?.items[0];
  const newer = latest.data?.items[0];
  const hasNew = feed.data && newer && newer.id !== first?.id && (!first || newer.at >= first.at);
  const anyEntity = eventColumnField(schema, 'about');
  const count = filterCount(filters);
  return (
    <Page layout="fill" title="Home">
      <HomeScroll>
        <HomeWelcome reviewCount={reviewCount} />
        <Stack gap="small">
          <Tabs
            wrapLabels
            items={[
              { value: 'all', label: 'Everything' },
              { value: 'events', label: 'Conversations & notes' },
              { value: 'records', label: 'Record updates' },
            ]}
            value={mode}
            onChange={(tab) =>
              void setSearch({ tab: tab === 'all' ? undefined : tab, record: undefined })
            }
          />
          <HomeTools>
            <Input
              aria-label="Search activity"
              placeholder="Search your workspace activity…"
              value={search.q ?? ''}
              onChange={(e) =>
                void setSearch({ q: e.target.value || undefined }, { replace: true })
              }
            />
            <FeedFilterMenu
              filters={filters}
              anyEntity={anyEntity}
              onChange={(next) => void setSearch({ ...feedSearch(next), record: undefined })}
            />
          </HomeTools>
          {count ? (
            <Row>
              {filters.types.length ? (
                <FilterChip
                  field="Type"
                  value={filters.types.map((t) => objectLabel(schema, t)).join(', ')}
                  onRemove={() => void setSearch({ eventTypes: undefined })}
                />
              ) : null}
              {filters.channel ? (
                <FilterChip
                  field="Source"
                  value={filters.channel}
                  onRemove={() => void setSearch({ channel: undefined })}
                />
              ) : null}
              {filters.from || filters.to ? (
                <FilterChip
                  field="Added"
                  value={rangeText(filters.from, filters.to)}
                  onRemove={() => void setSearch({ from: undefined, to: undefined })}
                />
              ) : null}
              {filters.linked ? (
                <LinkedChip
                  id={filters.linked}
                  onRemove={() => void setSearch({ linked: undefined })}
                />
              ) : null}
            </Row>
          ) : null}
        </Stack>
        {hasNew ? (
          <Button
            onClick={() =>
              void client.resetQueries({
                queryKey: [session.workspace.id, 'home-feed', input],
                exact: true,
              })
            }
          >
            Show new updates
          </Button>
        ) : null}
        {latest.error ? (
          <Notice error>
            Couldn’t check for new activity.{' '}
            <Button variant="ghost" size="small" onClick={() => void latest.refetch()}>
              Try again
            </Button>
          </Notice>
        ) : null}
        {feed.error ? <QueryError error={feed.error} retry={() => void feed.refetch()} /> : null}
        {reverted ? (
          <div ref={revertFeedback} tabIndex={-1}>
            <Notice onDismiss={() => setReverted(false)}>Update reverted.</Notice>
          </div>
        ) : null}
        {feed.isPending ? <Notice>Loading your workspace…</Notice> : null}
        {feed.data && !days.length ? (
          <Empty
            title={
              count || search.q
                ? 'No activity matches your search'
                : 'Your workspace story starts here'
            }
            description={
              count || search.q
                ? 'Try another search or remove a filter.'
                : 'New records, conversations, and updates from your agents will appear here.'
            }
          />
        ) : null}
        {days.map(({ day, items }) => (
          <HomeDay key={day} heading={dayHeading(day)}>
            {items.map((item) => (
              <ActivityCard
                key={item.id}
                item={item}
                references={references}
                onOpen={() => void setSearch({ record: item.record.id })}
                onRevert={
                  item.canRevert
                    ? (event) => {
                        revertTrigger.current = event.currentTarget;
                        revert.reset();
                        setReverted(false);
                        setRevertTarget(item);
                      }
                    : undefined
                }
              />
            ))}
          </HomeDay>
        ))}
        {feed.hasNextPage ? (
          <Button disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : days.length ? (
          <Muted small>You’re all caught up.</Muted>
        ) : null}
      </HomeScroll>
      <Dialog
        open={revertTarget !== null}
        onOpenChange={(open) => {
          if (!open && !revert.isPending) setRevertTarget(null);
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          revertCancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (revertFeedback.current ?? revertTrigger.current)?.focus();
        }}
        title="Revert this update?"
        description="Revert the field changes on this card. Retainer will restore earlier values where possible and keep newer edits."
        closeDisabled={revert.isPending}
      >
        {revert.error ? <Notice error>{revert.error.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button
            ref={revertCancel}
            disabled={revert.isPending}
            onClick={() => setRevertTarget(null)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={revert.isPending || !revertTarget}
            onClick={() => {
              if (revertTarget) revert.mutate(revertTarget);
            }}
          >
            {revert.isPending ? 'Reverting…' : 'Revert update'}
          </Button>
        </div>
      </Dialog>
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

function LinkedChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const record = useRecordLabel(id);
  return (
    <FilterChip
      field="Linked to"
      value={record.data ? recordTitle(record.data) : 'Selected record'}
      onRemove={onRemove}
    />
  );
}

function ActivityCard({
  item,
  references,
  onOpen,
  onRevert,
}: {
  item: WorkspaceFeedItem;
  references: Record<string, RecordReference>;
  onOpen: () => void;
  onRevert?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { schema } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const record = item.record;
  const object = objectByName(schema, record.object);
  const event = record.event;
  const label = event ? eventTitle(event) : recordTitle(record);
  const changes = expanded ? item.changes : item.changes.slice(0, 2);
  const summary = event?.summary;
  const about = event?.about ?? [];
  const source = item.changes.find((change) => change.source)?.source;
  const anyEntity = eventColumnField(schema, 'about');
  const Display = fields.relation.Display;
  const contextFields =
    object?.fields
      .filter(
        (field) =>
          field.name !== object.labelField &&
          field.type !== 'json' &&
          !fields[field.type].isEmpty(record.fields[field.name]),
      )
      .slice(0, 2) ?? [];
  return (
    <HomeCard
      record={record}
      label={label}
      type={
        event
          ? (object?.labelSingular ?? 'Event')
          : `${object?.labelSingular ?? 'Record'} · ${item.kind === 'record_created' ? 'Added' : 'Updated'}`
      }
      time={
        <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
          {new Date(item.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </time>
      }
      title={
        <HomeTitle onClick={onOpen} recordId={record.id}>
          {label}
        </HomeTitle>
      }
      footer={
        <>
          <ActorBadge actor={item.actor} />
          {event?.channel ? <span>{event.channel}</span> : null}
          {source ? <EventLink id={source.id}>{eventTitle(source)}</EventLink> : null}
          <Link to="/r/$id" params={{ id: record.id }}>
            Open {event ? 'conversation' : 'record'}
          </Link>
          {onRevert ? (
            <Button
              variant="ghost"
              size="small"
              className="ml-auto pointer-coarse:min-h-11"
              onClick={onRevert}
            >
              Revert update
            </Button>
          ) : null}
        </>
      }
    >
      {summary ? (
        <HomeSummary>
          {expanded || summary.length < 220 ? summary : `${summary.slice(0, 220)}…`}
        </HomeSummary>
      ) : null}
      {event && new Date(event.occurredAt).toDateString() !== new Date(item.at).toDateString() ? (
        <Muted small>
          Occurred{' '}
          {new Date(event.occurredAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}{' '}
          · Added{' '}
          {new Date(item.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </Muted>
      ) : null}
      {event && (event.participants.matched.length || event.participants.unmatched.length) ? (
        <Row>
          <Muted small>With</Muted>
          <ParticipantsCell
            record={record}
            field={anyEntity}
            references={references}
            compact={false}
          />
        </Row>
      ) : null}
      {about.length ? (
        <Row>
          <Muted small>About</Muted>
          <Display field={anyEntity} value={about} references={references} />
        </Row>
      ) : null}
      {item.kind === 'record_created'
        ? contextFields.map((field) => {
            const FieldDisplay = fields[field.type].Display;
            return (
              <HomeChange key={field.name} label={field.label}>
                <FieldDisplay
                  field={field}
                  value={record.fields[field.name]}
                  references={references}
                />
              </HomeChange>
            );
          })
        : null}
      {changes.map((change) => {
        const field = object?.fields.find((f) => f.name === change.field);
        if (!field) return null;
        const module = fields[field.type];
        return (
          <HomeChange
            key={change.id}
            label={`${field.label} ${module.isEmpty(change.value) ? 'cleared' : 'recorded as'}`}
          >
            {!module.isEmpty(change.value) ? (
              <module.Display
                field={field}
                value={change.value}
                references={change.relationReferences}
              />
            ) : null}
            {!change.current ? <Badge>Not the current value</Badge> : null}
          </HomeChange>
        );
      })}
      {item.changes.length > 2 || (summary?.length ?? 0) >= 220 ? (
        <Button variant="ghost" size="small" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? 'Show less'
            : item.changes.length > 2
              ? `Show ${item.changes.length - 2} more ${item.changes.length === 3 ? 'update' : 'updates'}`
              : 'Read more'}
        </Button>
      ) : null}
    </HomeCard>
  );
}
