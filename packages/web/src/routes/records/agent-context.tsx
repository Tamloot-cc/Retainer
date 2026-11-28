import type { ContextPack, ObjectView, PresentedRecord } from '@retainer/shared';
import { isInverseRelation } from '@retainer/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock, Lightbulb, Link2 } from 'lucide-react';
import { useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { ActorBadge } from '../../provenance/index.js';
import {
  Badge,
  Button,
  Code,
  CopyButton,
  Entry,
  EntryList,
  EntryLoading,
  EntryText,
  EntryTime,
  EventLink,
  JsonBlock,
  Muted,
  RecordLink,
  Row,
  Section,
  Segmented,
  Stack,
} from '../../ui/index.js';
import { ViaLabel } from '../events/event-details.js';
import { eventTitle, objectByName, objectLabel, QueryError, useRecordLabel } from '../state.js';

/**
 * The budgets the tab offers (agent view spec §5): what an agent gets by
 * default, and two larger ones `get_context` accepts.
 */
export const CONTEXT_BUDGETS = [2000, 8000, 16000] as const;
export type ContextBudget = (typeof CONTEXT_BUDGETS)[number];

const count = (n: number, one: string, many: string = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What each section's left-out count is called. */
const LEFT_OUT_WORDS = {
  linkedRecords: ['linked record', 'linked records'],
  facts: ['fact', 'facts'],
  recentEvents: ['event', 'events'],
} as const;

const words = (section: keyof typeof LEFT_OUT_WORDS, n: number) =>
  count(n, LEFT_OUT_WORDS[section][0], LEFT_OUT_WORDS[section][1]);

/** "Left out: 1 event", or nothing when the whole pack fit. */
export function leftOutSummary(omitted: ContextPack['omitted']): string | null {
  const parts = (Object.keys(LEFT_OUT_WORDS) as (keyof typeof LEFT_OUT_WORDS)[])
    .filter((section) => omitted[section] > 0)
    .map((section) => words(section, omitted[section]));
  return parts.length ? `Left out: ${parts.join(', ')}` : null;
}

/** "1 event did not fit", for the end of a section. */
export function leftOutLine(section: keyof ContextPack['omitted'], n: number): string {
  return `${words(section, n)} did not fit`;
}

/**
 * The record's fields that hold no value, and so are not sent. Inverse
 * relations are left out: they are read only and the agent gets those records
 * under linked records.
 */
export function fieldsNotSent(pack: ContextPack, object: ObjectView | undefined): number {
  if (!object) return 0;
  return object.fields.filter((f) => !isInverseRelation(f) && !(f.name in pack.record.fields))
    .length;
}

/** "about 1,922 of 2,000 tokens". */
export const sizeLine = (pack: ContextPack, budget: number) =>
  `about ${pack.tokenEstimate.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens`;

/** The next budget up, to fit what was left out; none at the largest. */
export const largerBudget = (budget: ContextBudget): ContextBudget | undefined =>
  CONTEXT_BUDGETS.find((b) => b > budget);

/** A value as stored: strings as they are, anything else as compact JSON. */
const stored = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * The Agent context tab (agent view spec §5): the `get_context` result for
 * this record, in the order the agent receives it, with what was left out.
 * Fetched with the person's own session; with whole-workspace access an
 * agent's call for the same record returns the same pack.
 */
export function AgentContextPanel({ record }: { record: PresentedRecord }) {
  const { session, schema } = useWorkspace();
  const [budget, setBudget] = useState<ContextBudget>(CONTEXT_BUDGETS[0]),
    [raw, setRaw] = useState(false);
  const query = useQuery({
    queryKey: [session.workspace.id, 'agent-context', record.id, budget],
    queryFn: ({ signal }) => api.context(record.id, { tokenBudget: budget }, signal),
    placeholderData: keepPreviousData,
  });
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <EntryLoading label="Loading agent context…" />;
  return (
    <AgentContextView
      pack={query.data}
      object={objectByName(schema, record.object)}
      budget={budget}
      onBudget={setBudget}
      raw={raw}
      onRaw={setRaw}
    />
  );
}

export function AgentContextView({
  pack,
  object,
  budget,
  onBudget,
  raw,
  onRaw,
}: {
  pack: ContextPack;
  object: ObjectView | undefined;
  budget: ContextBudget;
  onBudget: (budget: ContextBudget) => void;
  raw: boolean;
  onRaw: (raw: boolean) => void;
}) {
  const { schema } = useWorkspace();
  const leftOut = leftOutSummary(pack.omitted);
  const larger = largerBudget(budget);
  const notSent = fieldsNotSent(pack, object);
  const values = Object.entries(pack.record.fields);
  const plural = (name: string) => objectByName(schema, name)?.labelPlural ?? name;
  const eventTitles = new Map(pack.recentEvents.map((e) => [e.id, eventTitle(e)]));
  /** The line that ends a section when some of it did not fit. */
  const more = (section: keyof ContextPack['omitted']) =>
    pack.omitted[section] > 0 ? (
      <Row>
        <Muted small>{leftOutLine(section, pack.omitted[section])}.</Muted>
        {larger ? (
          <Button variant="ghost" size="small" onClick={() => onBudget(larger)}>
            Raise the budget to {larger.toLocaleString('en-US')}
          </Button>
        ) : null}
      </Row>
    ) : null;
  return (
    <Stack>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 text-sm">
          <p className="m-0 font-medium">What an agent gets when it reads this record</p>
          <p className="m-0 text-xs text-muted-foreground">
            {sizeLine(pack, budget)}
            {leftOut ? ` · ${leftOut}` : ''}
          </p>
        </div>
        <Segmented
          label="Token budget"
          value={String(budget)}
          options={CONTEXT_BUDGETS.map((b) => ({
            value: String(b),
            label: b.toLocaleString('en-US'),
          }))}
          onChange={(value) => onBudget(Number(value) as ContextBudget)}
        />
        <Button variant="ghost" size="small" aria-pressed={raw} onClick={() => onRaw(!raw)}>
          {raw ? 'Show sections' : 'Show raw'}
        </Button>
      </div>
      {raw ? (
        <Stack>
          <Row>
            <CopyButton value={JSON.stringify(pack, null, 2)} label="Copy JSON" />
          </Row>
          <JsonBlock value={pack} label="Agent context JSON" />
        </Stack>
      ) : (
        <>
          <Section title="Values">
            {values.length ? (
              <dl className="m-0 flex flex-col divide-y divide-border text-sm">
                {values.map(([name, field]) => (
                  <div
                    key={name}
                    className="grid grid-cols-1 gap-x-3 gap-y-1 py-2 sm:grid-cols-[minmax(6rem,12rem)_minmax(0,1fr)]"
                  >
                    <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {name}
                    </dt>
                    <dd className="m-0 flex min-w-0 flex-col items-start gap-1">
                      <Code>{stored(field.value)}</Code>
                      <Row>
                        <ActorBadge actor={field.writtenBy} />
                        <Muted small>
                          observed <EntryTime at={field.observedAt} label="Observed" />
                        </Muted>
                      </Row>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <Muted small>No values.</Muted>
            )}
            {notSent ? (
              <Muted small>
                {count(notSent, 'field has', 'fields have')} no value and{' '}
                {notSent === 1 ? 'is' : 'are'} not sent.
              </Muted>
            ) : null}
          </Section>
          <Section title="Linked records">
            {pack.linkedRecords.length ? (
              pack.linkedRecords.map((group) => (
                <Stack key={group.object} gap="small">
                  <p className="m-0 text-xs font-medium">
                    {plural(group.object)} <Muted small>({group.total})</Muted>
                  </p>
                  <EntryList label={plural(group.object)}>
                    {group.items.map((item) => (
                      <Entry
                        key={item.id}
                        icon={Link2}
                        title={
                          <>
                            <RecordLink id={item.id}>{item.title ?? item.id}</RecordLink>
                            <Code>{item.via.field}</Code>
                          </>
                        }
                      >
                        {Object.keys(item.selects).length ? (
                          <Row>
                            {Object.entries(item.selects).map(([key, value]) => (
                              <Code key={key}>
                                {key}: {stored(value)}
                              </Code>
                            ))}
                          </Row>
                        ) : null}
                      </Entry>
                    ))}
                  </EntryList>
                </Stack>
              ))
            ) : (
              <Muted small>No linked records.</Muted>
            )}
            {more('linkedRecords')}
          </Section>
          <Section title="Facts">
            {pack.facts.length ? (
              <EntryList label="Facts in the pack">
                {pack.facts.map((fact) => (
                  <Entry
                    key={fact.id}
                    icon={Lightbulb}
                    title={<ActorBadge actor={fact.writtenBy} />}
                    time={<EntryTime at={fact.validFrom} label="Valid from" />}
                    footer={
                      fact.internal ? (
                        <Muted small>Internal note</Muted>
                      ) : (
                        fact.sources.map((source) => (
                          <SourceEventLink
                            key={source}
                            id={source}
                            title={eventTitles.get(source)}
                          />
                        ))
                      )
                    }
                  >
                    <EntryText>{fact.content}</EntryText>
                  </Entry>
                ))}
              </EntryList>
            ) : (
              <Muted small>No facts.</Muted>
            )}
            {more('facts')}
          </Section>
          <Section title="Recent events">
            {pack.recentEvents.length ? (
              <EntryList label="Events in the pack">
                {pack.recentEvents.map((event) => (
                  <Entry
                    key={event.id}
                    icon={CalendarClock}
                    title={
                      <>
                        <EventLink id={event.id} title>
                          {eventTitle(event)}
                        </EventLink>
                        <Badge>{objectLabel(schema, event.type)}</Badge>
                        <ViaLabel
                          via={event.via}
                          eventObject={objectByName(schema, event.type)}
                          recordObject={object}
                        />
                      </>
                    }
                    time={<EntryTime at={event.occurredAt} label="Occurred" />}
                  >
                    {event.summary ? <EntryText clamp={3}>{event.summary}</EntryText> : null}
                  </Entry>
                ))}
              </EntryList>
            ) : (
              <Muted small>No events.</Muted>
            )}
            {more('recentEvents')}
          </Section>
        </>
      )}
    </Stack>
  );
}

/**
 * A fact's source event by its title: from the pack when the event is among
 * its recent events, otherwise read, since facts and events are budgeted apart.
 */
function SourceEventLink({ id, title }: { id: string; title: string | undefined }) {
  const label = useRecordLabel(id, title === undefined);
  const fetched = label.data ? eventTitle({ title: label.data.label }) : undefined;
  return <EventLink id={id}>{title ?? fetched ?? 'Source event'}</EventLink>;
}
