import type {
  AssertionView,
  FieldView,
  ObjectView,
  PresentedFact,
  PresentedRecord,
  RecordCounts,
  SchemaDescription,
} from '@retainer/shared';
import { isCollectionRelation, TASK_DONE_OPTION } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Circle, CircleCheck, Lightbulb, PencilLine, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { selectOptions } from '../../fields/common.js';
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
  SelectMenu,
  Stack,
  TabPanel,
  Tabs,
  useTabAnchor,
} from '../../ui/index.js';
import { useDeveloper } from '../developer.js';
import { REASONS, ViaLabel } from '../events/event-details.js';
import {
  byCursor,
  eventTitle,
  joined,
  list,
  objectByName,
  objectLabel,
  QueryError,
  recordTitle,
  relationsTo,
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
export type MemoryState = { tab?: string; fields?: string; tasks?: string };
export type MemoryNav = MemoryState & { set: (change: MemoryState) => void };

/** The memory tabs' state in the address, for a page. */
export function useMemoryNav(): MemoryNav {
  const { search, setSearch } = useView();
  return {
    // An address saved when History was called Timeline still opens it.
    tab: search.tab === 'timeline' ? 'history' : search.tab,
    fields: search.fields,
    tasks: search.tasks,
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
  tasks: 'Tasks linked to this record, by status. The number counts those not done yet.',
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
 * Tasks shows only when a task relation can point at this type, and the
 * events tab keeps `events` in the address, where people read it as Activity.
 */
export function memoryTabs({
  isEvent,
  hasTasks,
  counts,
  developer,
}: {
  isEvent: boolean;
  hasTasks: boolean;
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
        ...(hasTasks
          ? [{ value: 'tasks' as const, label: 'Tasks', ...counted(counts?.openTasks) }]
          : []),
      ];
  const all: MemoryTab[] = developer ? [...tabs, { value: 'json', label: 'JSON' }] : tabs;
  return all.map((t) => ({ ...t, hint: TAB_HINTS[t.value] }));
}

/** Where a record opens: what people wrote if there is any, else what agents remember. */
export const defaultMemoryTab = (isEvent: boolean, counts?: RecordCounts) =>
  isEvent || counts?.comments ? 'comments' : 'facts';

/**
 * The task object's role fields and the relations that can point at `object`.
 * Found by role, not name: a workspace may rename the task object and its fields.
 */
export function taskLinksTo(schema: Pick<SchemaDescription, 'objects'>, object: string) {
  const task = schema.objects.find((o) => o.baseObject === 'task');
  return {
    task,
    status: task?.fields.find((f) => f.baseField === 'taskStatus'),
    due: task?.fields.find((f) => f.baseField === 'taskDueDate'),
    links: task ? relationsTo(task.fields, object).filter((f) => f.isFilterable) : [],
  };
}

/** The tabbed bottom of a record or event: its comments and memory. */
export function MemoryTabs({ record, nav }: { record: PresentedRecord; nav: MemoryNav }) {
  const { schema } = useWorkspace(),
    developer = useDeveloper();
  const isEvent = !!record.event;
  const { task, status, due, links } = taskLinksTo(schema, record.object);
  const hasTasks = !isEvent && links.length > 0;
  const tabs = memoryTabs({ isEvent, hasTasks, counts: record.counts, developer });
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
        onChange={(next) => nav.set({ tab: next, fields: undefined, tasks: undefined })}
      />
      <TabPanel ref={anchor.panel}>
        {tab === 'comments' ? <CommentsPanel recordId={rid} /> : null}
        {tab === 'facts' ? <FactsPanel recordId={rid} /> : null}
        {tab === 'events' ? <ActivityPanel record={record} /> : null}
        {tab === 'history' ? (
          <RecordHistory
            recordId={rid}
            object={object}
            fields={nav.fields}
            onFieldsChange={(fields) => nav.set({ fields })}
          />
        ) : null}
        {tab === 'tasks' && task && status ? (
          <TasksPanel
            record={record}
            task={task}
            status={status}
            due={due}
            links={links}
            shown={nav.tasks}
            onShownChange={(tasks) => nav.set({ tasks })}
          />
        ) : null}
        {tab === 'claims' ? <ClaimsPanel eventId={rid} /> : null}
        {tab === 'json' ? (
          <JsonBlock value={record} label={isEvent ? 'Event JSON' : 'Record JSON'} />
        ) : null}
      </TabPanel>
    </div>
  );
}

export function FactRow({
  fact,
  onRetract,
  retractLabel = 'Retract fact',
  children,
}: {
  fact: PresentedFact;
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
      <EntryText clamp={4}>{fact.content}</EntryText>
      {children}
    </Entry>
  );
}

function FactsPanel({ recordId }: { recordId: string }) {
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
  const canWrite = canMutate(session);
  const items = facts.data?.pages.flatMap((p) => p.facts) ?? [];
  async function retractFact() {
    if (!retract) return;
    setBusy(true);
    try {
      await api.retractFact(retract);
      setRetract(null);
      setMessage('Fact retracted');
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
      {facts.data && !items.length ? (
        <Empty
          quiet
          title="No facts yet"
          description="What agents learn about this record appears here, with where they read it."
        />
      ) : null}
      {items.length ? (
        <EntryList label="Facts">
          {items.map((f) => (
            <FactRow
              key={f.id}
              fact={f}
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
        title="Retract this fact?"
        description="It will disappear from current memory. Its history remains stored."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void retractFact()}>
          Retract fact
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

/**
 * Which tasks the tab shows, from the address: by default every one that is not
 * done, `all`, or a comma list of status values. Only `done` is a fixed status;
 * a workspace can add, rename and remove the others, so they come from its
 * schema. A default that names them would miss a task with no status at all,
 * so it stays "not done".
 */
export function taskStatusFilter(options: string[], shown: string | undefined) {
  const open = options.filter((o) => o !== TASK_DONE_OPTION);
  if (shown === 'all') return { open, chosen: [], condition: null, isDefault: false };
  // In the options' order, so the same statuses are the same query however they were ticked.
  const wanted = list(shown);
  const asked = options.filter((o) => wanted.includes(o));
  return asked.length
    ? { open, chosen: asked, condition: { in: asked }, isDefault: false }
    : { open, chosen: open, condition: { neq: TASK_DONE_OPTION }, isDefault: true };
}

/** What to keep in the address for these statuses: none means all of them. */
export function taskStatusSearch(open: string[], next: string[]) {
  if (!next.length) return 'all';
  const isOpen = next.length === open.length && open.every((o) => next.includes(o));
  return isOpen ? undefined : joined(next);
}

/**
 * A record's tasks by status, soonest due first; only done tasks, latest due
 * first, since the recent ones are what people look back for.
 */
function TasksPanel({
  record,
  task,
  status,
  due,
  links,
  shown,
  onShownChange,
}: {
  record: PresentedRecord;
  task: ObjectView;
  status: FieldView;
  due?: FieldView;
  links: FieldView[];
  shown?: string;
  onShownChange: (shown: string | undefined) => void;
}) {
  const { session } = useWorkspace();
  const statusOptions = selectOptions(status);
  const { open, chosen, condition, isDefault } = taskStatusFilter(
    statusOptions.map((o) => o.value),
    shown,
  );
  const onlyDone = chosen.length === 1 && chosen[0] === TASK_DONE_OPTION;
  const filter = {
    and: [
      ...(condition ? [{ [status.name]: condition }] : []),
      { or: links.map((f) => ({ [f.name]: pointsAt(f, record.id) })) },
    ],
  };
  const tasks = useInfiniteQuery({
    queryKey: [session.workspace.id, 'tasks', record.id, condition],
    queryFn: ({ signal, pageParam }) =>
      api.queryRecords(
        task.nameSingular,
        {
          filter,
          limit: 50,
          cursor: pageParam,
          sort: due ? [{ field: due.name, direction: onlyDone ? 'desc' : 'asc' }] : [],
        },
        signal,
      ),
    ...byCursor,
  });
  const items = tasks.data?.pages.flatMap((p) => p.records) ?? [];
  const value = (field: FieldView | undefined, row: PresentedRecord) => {
    if (!field || row.fields[field.name] == null) return null;
    const Display = fields[field.type].Display;
    return (
      <Display field={field} value={row.fields[field.name]} references={row.relationReferences} />
    );
  };
  return (
    <Stack>
      <Row>
        <SelectMenu
          label="Status"
          size="small"
          multiple
          placeholder={isDefault ? 'Not done' : 'All statuses'}
          value={chosen}
          options={statusOptions}
          onChange={(next) => onShownChange(taskStatusSearch(open, next))}
        />
        {isDefault ? null : (
          <Button size="small" variant="ghost" onClick={() => onShownChange(undefined)}>
            Clear filters
          </Button>
        )}
      </Row>
      {tasks.error ? <QueryError error={tasks.error} retry={() => void tasks.refetch()} /> : null}
      {tasks.isPending ? <EntryLoading label="Loading tasks…" /> : null}
      {tasks.data && !items.length ? (
        <Empty
          quiet
          title={
            isDefault ? 'No open tasks' : condition ? 'No tasks with these statuses' : 'No tasks'
          }
          description={
            isDefault
              ? 'Tasks linked to this record appear here until they are done.'
              : 'Tasks linked to this record appear here.'
          }
        />
      ) : null}
      {items.length ? (
        <EntryList label="Tasks">
          {items.map((t) => {
            const done = t.fields[status.name] === TASK_DONE_OPTION;
            return (
              <Entry
                key={t.id}
                icon={done ? CircleCheck : Circle}
                title={
                  <>
                    <RecordLink id={t.id} struck={done}>
                      {t.label || 'Untitled task'}
                    </RecordLink>
                    {value(status, t)}
                  </>
                }
                time={value(due, t)}
              />
            );
          })}
        </EntryList>
      ) : null}
      {tasks.hasNextPage ? (
        <LoadMore loading={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()} />
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
