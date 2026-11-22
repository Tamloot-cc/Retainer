import type {
  AssertionView,
  FieldView,
  LinkedRecord,
  ObjectView,
  PresentedFact,
  PresentedRecord,
  RecordCounts,
} from '@retainer/shared';
import { isCollectionRelation } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Lightbulb, Link2, PencilLine, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { ActorBadge, FactSources } from '../../provenance/index.js';
import {
  Badge,
  Button,
  Code,
  Dialog,
  Empty,
  Entry,
  EntryList,
  EntryLoading,
  EntryQuote,
  EntryText,
  EntryTime,
  EventLink,
  JsonBlock,
  LoadMore,
  Muted,
  Notice,
  RecordLink,
  Row,
  Section,
  Stack,
  TabPanel,
  Tabs,
  useTabAnchor,
} from '../../ui/index.js';
import { ApiLabel, useDeveloper } from '../developer.js';
import { REASONS, ViaLabel } from '../events/event-details.js';
import {
  byCursor,
  eventTitle,
  objectByName,
  objectLabel,
  QueryError,
  recordTitle,
  useView,
} from '../state.js';
import { CommentsPanel } from './comments.js';
import { CandidateRecord } from './record-actions.js';
import { RecordHistory } from './record-history.js';

/**
 * A filter condition for "this relation points at `id`": `eq` on a
 * single-record field, `containsAny` on a set. A many_to_many field, owning
 * or inverse, pairs with a set on the other side too.
 */
export const pointsAt = (field: FieldView, id: string) =>
  isCollectionRelation(field) ? { containsAny: [id] } : { eq: id };

/**
 * Where the memory tabs keep their tab and filters: the URL on a page, local
 * state in the sheet.
 */
export type MemoryState = { tab?: string; fields?: string; fact?: string };
export type MemoryNav = MemoryState & { set: (change: MemoryState) => void };

/** The memory tabs' state in the address, for a page. */
export function useMemoryNav(): MemoryNav {
  const { search, setSearch } = useView();
  return {
    // An address saved when History was called Timeline still opens it.
    tab: search.tab === 'timeline' ? 'history' : search.tab,
    fields: search.fields,
    fact: search.fact,
    set: (change) => void setSearch(change),
  };
}

/** A count on a tab only when there is something to count. */
const counted = (count: number | undefined) => (count ? { count } : {});

/** What each tab holds, in plain words, for its info button. */
const TAB_HINTS = {
  comments: 'Notes your team wrote about this record.',
  facts: 'What is known about this record, in plain words. Each fact shows where it came from.',
  events: 'Meetings, calls, emails and other events linked to this record.',
  linked: 'Records connected to this one through a relation field in either direction.',
  claims:
    'What came out of this event: field values and facts saved on other records because of it. A value that is no longer current is marked.',
  history: 'Values set on these fields over time, and who set them.',
  json: 'This record’s raw data, as the API returns it.',
};

/** One tab of a record's memory. Its value must have a hint, so a new tab can't skip one. */
type MemoryTab = { value: keyof typeof TAB_HINTS; label: string; count?: number };

/**
 * The tabs of a record's memory. An event's are what is written on it, what
 * cites it and how its fields changed; an event has no activity of its own (5.1).
 * `remember` can still store a fact on an event, so an event that has some keeps
 * a Facts tab: memory stays reachable, and the usual event doesn't show the tab.
 * The events tab keeps `events` in the address, where people read it as Activity.
 */
export function memoryTabs({
  isEvent,
  counts,
  developer,
}: {
  isEvent: boolean;
  counts?: RecordCounts;
  developer: boolean;
}) {
  const comments = {
    value: 'comments' as const,
    label: 'Comments',
    ...counted(counts?.comments),
  };
  const tabs: MemoryTab[] = isEvent
    ? [
        comments,
        { value: 'claims', label: 'Claims', ...counted(counts?.claims) },
        { value: 'history', label: 'History' },
        ...(counts?.facts
          ? [{ value: 'facts' as const, label: 'Facts', count: counts.facts }]
          : []),
      ]
    : [
        comments,
        { value: 'facts', label: 'Facts', ...counted(counts?.facts) },
        { value: 'events', label: 'Activity' },
        { value: 'history', label: 'History' },
        { value: 'linked', label: 'Linked', ...counted(counts?.linked) },
      ];
  const all: MemoryTab[] = developer ? [...tabs, { value: 'json', label: 'JSON' }] : tabs;
  return all.map((t) => ({ ...t, hint: TAB_HINTS[t.value] }));
}

/** Where a record opens: what people wrote if there is any, else what agents remember. */
export const defaultMemoryTab = (isEvent: boolean, counts?: RecordCounts) =>
  isEvent || counts?.comments ? 'comments' : 'facts';

/** The tabbed bottom of a record or event: its comments and memory. */
export function MemoryTabs({ record, nav }: { record: PresentedRecord; nav: MemoryNav }) {
  const { schema } = useWorkspace(),
    developer = useDeveloper();
  const isEvent = !!record.event;
  const tabs = memoryTabs({ isEvent, counts: record.counts, developer });
  // Chosen once: removing the last comment doesn't move anyone off the tab.
  const [opening] = useState(() => defaultMemoryTab(isEvent, record.counts));
  const tab = tabs.some((t) => t.value === nav.tab) ? (nav.tab as string) : opening;
  const anchor = useTabAnchor(tab);
  const object = objectByName(schema, record.object);
  const rid = record.id;
  return (
    <div>
      <Tabs
        ref={anchor.nav}
        sticky
        value={tab}
        items={tabs}
        onChange={(next) => nav.set({ tab: next, fields: undefined, fact: undefined })}
      />
      <TabPanel ref={anchor.panel}>
        {tab === 'comments' ? <CommentsPanel recordId={rid} /> : null}
        {tab === 'facts' ? <FactsPanel recordId={rid} targetFact={nav.fact} /> : null}
        {tab === 'events' ? <ActivityPanel record={record} /> : null}
        {tab === 'history' ? (
          <RecordHistory
            recordId={rid}
            object={object}
            fields={nav.fields}
            onFieldsChange={(fields) => nav.set({ fields })}
          />
        ) : null}
        {tab === 'linked' ? <LinkedPanel recordId={rid} anchorObject={object} /> : null}
        {tab === 'claims' ? <ClaimsPanel eventId={rid} /> : null}
        {tab === 'json' ? (
          <JsonBlock value={record} label={isEvent ? 'Event JSON' : 'Record JSON'} />
        ) : null}
      </TabPanel>
    </div>
  );
}

function FactRow({
  fact,
  onRetract,
  retractLabel = 'Retract fact',
  children,
  focused,
}: {
  fact: PresentedFact;
  focused?: boolean;
  onRetract?: () => void;
  retractLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <Entry
      icon={Lightbulb}
      title={
        <>
          <ActorBadge actor={fact.writtenBy} />
          {fact.kind === 'inferred' ? <Badge>Inferred</Badge> : null}
          {fact.status && fact.status !== 'current' ? <Badge>{fact.status}</Badge> : null}
        </>
      }
      time={<EntryTime at={fact.validFrom} label="Valid from" />}
      actions={
        onRetract ? (
          <Button
            variant="ghost"
            size="iconSmall"
            aria-label={retractLabel}
            title={retractLabel}
            onClick={onRetract}
          >
            <Undo2 size={13} />
          </Button>
        ) : null
      }
    >
      <div
        id={`fact-${fact.id}`}
        tabIndex={-1}
        className={
          focused ? 'rounded-md bg-selection p-2 outline-none ring-1 ring-ring' : undefined
        }
      >
        <EntryText clamp={4}>{fact.content}</EntryText>
      </div>
      {children}
    </Entry>
  );
}

/** What a facts list says: a record's facts by default, or a profile's (Settings → Memory). */
export type FactsWords = {
  list: string;
  empty: { title: string; description: string };
  retract: string;
  confirm: { title: string; description: string };
  done: string;
};

const RECORD_FACT_WORDS: FactsWords = {
  list: 'Facts',
  empty: {
    title: 'No facts yet',
    description: 'What agents learn about this record appears here, with where they read it.',
  },
  retract: 'Retract fact',
  confirm: {
    title: 'Retract this fact?',
    description: 'It will disappear from current memory. Its history remains stored.',
  },
  done: 'Fact retracted',
};

/**
 * The current facts of a record, or of `workspace` or `me`, with retraction
 * for whoever may retract them (people with `write` by default).
 */
export function FactsPanel({
  recordId,
  canRetract,
  words = RECORD_FACT_WORDS,
  targetFact,
}: {
  recordId: string;
  canRetract?: boolean;
  words?: FactsWords;
  targetFact?: string;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const facts = useInfiniteQuery({
    queryKey: [session.workspace.id, 'facts', recordId],
    queryFn: ({ signal, pageParam }) => api.facts(recordId, { cursor: pageParam, signal }),
    ...byCursor,
  });
  const [retract, setRetract] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const canWrite = canRetract ?? canMutate(session);
  const items = facts.data?.pages.flatMap((p) => p.facts) ?? [];
  const focused = useRef<string | undefined>(undefined);
  const targetLoaded = !!targetFact && items.some((f) => f.id === targetFact);
  useEffect(() => {
    if (!targetFact || focused.current === targetFact) return;
    if (targetLoaded) {
      const target = document.getElementById(`fact-${targetFact}`);
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
      focused.current = targetFact;
    } else if (facts.hasNextPage && !facts.isFetching && !facts.error) {
      void facts.fetchNextPage();
    }
  }, [
    targetFact,
    targetLoaded,
    facts.hasNextPage,
    facts.isFetching,
    facts.error,
    facts.fetchNextPage,
  ]);
  async function retractFact() {
    if (!retract) return;
    setBusy(true);
    try {
      await api.retractFact(retract);
      setRetract(null);
      setMessage(words.done);
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {message ? <Notice>{message}</Notice> : null}
      {facts.error ? <QueryError error={facts.error} retry={() => void facts.refetch()} /> : null}
      {facts.isPending ? <EntryLoading label="Loading facts…" /> : null}
      {facts.data && !items.length ? <Empty quiet {...words.empty} /> : null}
      {items.length ? (
        <EntryList label={words.list}>
          {items.map((f) => (
            <FactRow
              key={f.id}
              fact={f}
              focused={f.id === targetFact}
              retractLabel={words.retract}
              {...(canWrite ? { onRetract: () => setRetract(f.id) } : {})}
            >
              <FactSources sources={f.sources} />
            </FactRow>
          ))}
        </EntryList>
      ) : null}
      {facts.hasNextPage ? (
        <LoadMore loading={facts.isFetchingNextPage} onClick={() => void facts.fetchNextPage()} />
      ) : null}
      <Dialog
        open={!!retract}
        onOpenChange={(open) => {
          if (!open && !busy) setRetract(null);
        }}
        {...words.confirm}
      >
        <Button variant="destructive" disabled={busy} onClick={() => void retractFact()}>
          {words.retract}
        </Button>
      </Dialog>
    </>
  );
}

function ActivityPanel({ record }: { record: PresentedRecord }) {
  const { session, schema } = useWorkspace(),
    developer = useDeveloper();
  const events = useInfiniteQuery({
    queryKey: [session.workspace.id, 'recordEvents', record.id],
    queryFn: ({ signal, pageParam }) => api.recordEvents(record.id, { cursor: pageParam, signal }),
    ...byCursor,
  });
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  // Every record the events name, so no link fetches its own label.
  const references = Object.assign({}, ...(events.data?.pages.map((p) => p.references) ?? []));
  const object = objectByName(schema, record.object);
  return (
    <>
      {events.error ? (
        <QueryError error={events.error} retry={() => void events.refetch()} />
      ) : null}
      {events.isPending ? <EntryLoading label="Loading activity…" /> : null}
      {events.data && !items.length ? (
        <Empty
          quiet
          title="No activity yet"
          description="Conversations and other events this record took part in or is linked to appear here."
        />
      ) : null}
      {items.length ? (
        <EntryList label="Activity">
          {items.map((e) => (
            <Entry
              key={e.id}
              icon={CalendarClock}
              title={
                <>
                  <Badge>{objectLabel(schema, e.object)}</Badge>
                  <EventLink id={e.id} title>
                    {eventTitle(e.event)}
                  </EventLink>
                </>
              }
              time={<EntryTime at={e.event.occurredAt} />}
              footer={
                <>
                  <ViaLabel
                    via={e.via}
                    eventObject={objectByName(schema, e.object)}
                    recordObject={object}
                    references={references}
                  />
                  {e.event.participants.matched.map((p) => (
                    <CandidateRecord key={p.id} id={p.recordId} references={references} />
                  ))}
                  {e.event.participants.unmatched.map((p) => (
                    <Badge key={p.id}>
                      {p.handle || 'Unknown'} · {REASONS[p.reason] ?? p.reason}
                    </Badge>
                  ))}
                </>
              }
            >
              {e.event.summary ? <EntryText clamp={3}>{e.event.summary}</EntryText> : null}
              {developer ? (
                <Stack gap="small">
                  <Code>via {JSON.stringify(e.via)}</Code>
                  <Code>externalId {JSON.stringify(e.event.externalId)}</Code>
                </Stack>
              ) : null}
            </Entry>
          ))}
        </EntryList>
      ) : null}
      {events.hasNextPage ? (
        <LoadMore loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()} />
      ) : null}
    </>
  );
}

/** The same linked-record pages agents read, grouped for display. */
function LinkedPanel({ recordId, anchorObject }: { recordId: string; anchorObject?: ObjectView }) {
  const { schema, session } = useWorkspace();
  const linked = useInfiniteQuery({
    queryKey: [session.workspace.id, 'linkedRecords', recordId],
    queryFn: ({ signal, pageParam }) => api.linkedRecords(recordId, { cursor: pageParam, signal }),
    ...byCursor,
  });
  const groups = new Map<string, Map<string, LinkedRecord>>();
  for (const item of linked.data?.pages.flatMap((page) => page.items) ?? []) {
    let group = groups.get(item.object);
    if (!group) {
      group = new Map();
      groups.set(item.object, group);
    }
    group.set(item.id, item);
  }
  const totals = linked.data?.pages.at(-1)?.totals;
  return (
    <Stack>
      {linked.error ? (
        <QueryError error={linked.error} retry={() => void linked.refetch()} />
      ) : null}
      {linked.isPending ? <EntryLoading label="Loading linked records…" /> : null}
      {linked.data && !groups.size ? <Empty quiet title="No linked records" /> : null}
      {[...groups].map(([name, items]) => {
        const object = objectByName(schema, name);
        const label = object?.labelPlural ?? name;
        return (
          <Section key={name} title={`${label} (${totals?.[name] ?? items.size})`}>
            <EntryList label={label}>
              {[...items.values()].map((item) => {
                const owner = item.via.on === 'anchor' ? anchorObject : object;
                const relation = owner?.fields.find((field) => field.name === item.via.field);
                return (
                  <Entry
                    key={item.id}
                    icon={Link2}
                    title={
                      <>
                        <RecordLink id={item.id}>{recordTitle({ label: item.title })}</RecordLink>
                        {Object.entries(item.selects).map(([name, value]) => {
                          const field = object?.fields.find((f) => f.name === name);
                          if (!field) return null;
                          const Display = fields[field.type].Display;
                          return <Display key={name} field={field} value={value} />;
                        })}
                      </>
                    }
                    footer={
                      <>
                        <Muted small>
                          Via {relation?.label ?? 'relation field'} on{' '}
                          {item.via.on === 'anchor' ? 'this record' : 'the linked record'}
                        </Muted>
                        <ApiLabel name={item.via.field} />
                      </>
                    }
                  />
                );
              })}
            </EntryList>
          </Section>
        );
      })}
      {linked.hasNextPage ? (
        <LoadMore loading={linked.isFetchingNextPage} onClick={() => void linked.fetchNextPage()} />
      ) : null}
    </Stack>
  );
}

/** A value another record's field took from this event. */
function ClaimRow({ assertion }: { assertion: AssertionView }) {
  const { schema } = useWorkspace();
  const field = objectByName(schema, assertion.object)?.fields.find(
    (f) => f.name === assertion.field,
  );
  const Display = field ? fields[field.type].Display : null;
  return (
    <Entry
      icon={PencilLine}
      title={
        <>
          <RecordLink id={assertion.recordId}>
            {recordTitle({ label: assertion.recordLabel })}
          </RecordLink>
          {assertion.status === 'active' ? null : <Badge>{assertion.status}</Badge>}
        </>
      }
      time={<EntryTime at={assertion.observedAt} />}
      footer={<ActorBadge actor={assertion.actor} />}
    >
      <Row>
        <Muted small>{field?.label ?? assertion.field} set to</Muted>
        {field && Display ? (
          <Display
            field={field}
            value={assertion.value}
            references={assertion.relationReferences}
          />
        ) : (
          <Code>{JSON.stringify(assertion.value)}</Code>
        )}
      </Row>
    </Entry>
  );
}

/** What cites this event: values on other records, and facts. */
function ClaimsPanel({ eventId }: { eventId: string }) {
  const { session } = useWorkspace();
  const key = [session.workspace.id, 'claims', eventId];
  const values = useInfiniteQuery({
    queryKey: [...key, 'assertions'],
    queryFn: ({ signal, pageParam }) =>
      api.claims(eventId, { own: false, assertionsCursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursors.assertions ?? undefined,
  });
  const facts = useInfiniteQuery({
    queryKey: [...key, 'facts'],
    queryFn: ({ signal, pageParam }) =>
      api.claims(eventId, { own: false, factsCursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursors.facts ?? undefined,
  });
  const assertions = values.data?.pages.flatMap((p) => p.assertions) ?? [];
  const cited = facts.data?.pages.flatMap((p) => p.facts) ?? [];
  const error = values.error ?? facts.error;
  return (
    <>
      {error ? (
        <QueryError
          error={error}
          retry={() => {
            void values.refetch();
            void facts.refetch();
          }}
        />
      ) : null}
      {values.isPending || facts.isPending ? <EntryLoading label="Loading claims…" /> : null}
      {values.data && facts.data && !assertions.length && !cited.length ? (
        <Empty
          quiet
          title="No claims yet"
          description="Values and facts on other records that cite this event appear here."
        />
      ) : null}
      {assertions.length ? (
        <Section title="Values">
          <EntryList label="Values citing this event">
            {assertions.map((a) => (
              <ClaimRow key={a.id} assertion={a} />
            ))}
          </EntryList>
          {values.hasNextPage ? (
            <LoadMore
              loading={values.isFetchingNextPage}
              onClick={() => void values.fetchNextPage()}
            />
          ) : null}
        </Section>
      ) : null}
      {cited.length ? (
        <Section title="Facts">
          <EntryList label="Facts citing this event">
            {cited.map((f) => (
              <FactRow key={f.id} fact={f}>
                {f.sources
                  .filter((s) => s.event === eventId && s.quote)
                  .map((s) => (
                    <EntryQuote key={`${s.event}:${s.quote}`}>{s.quote}</EntryQuote>
                  ))}
                {f.record ? (
                  <div>
                    <RecordLink id={f.record}>View record</RecordLink>
                  </div>
                ) : null}
              </FactRow>
            ))}
          </EntryList>
          {facts.hasNextPage ? (
            <LoadMore
              loading={facts.isFetchingNextPage}
              onClick={() => void facts.fetchNextPage()}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
