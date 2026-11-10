import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  QueryInput,
  RecordReference,
  SavedView,
  SchemaDescription,
} from '@retainer/shared';
import { filterOperatorsFor } from '@retainer/shared';
import { CircleHelp } from 'lucide-react';
import { useContext } from 'react';
import { WorkspaceContext } from '../../api/client.js';
import { relationItems } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import { Code, FitList, Muted, PanelBody, Popover, Stack } from '../../ui/index.js';

// Event type lists (5.3): the grid of an object list, with an event's
// built-in columns and links shown as columns beside its fields.

/**
 * The built-in columns and links an event list shows beside the fields. Their
 * names are reserved for event fields (`RESERVED_EVENT_FIELD_NAMES`), so none
 * can collide with a field.
 */
export const EVENT_LIST_COLUMNS = [
  'occurredAt',
  'participants',
  'about',
  'channel',
  'externalId',
] as const;
export type EventListColumn = (typeof EVENT_LIST_COLUMNS)[number];
export const isEventColumn = (name: string): name is EventListColumn =>
  (EVENT_LIST_COLUMNS as readonly string[]).includes(name);

/** The sort every event list starts with: newest first. */
export const DEFAULT_EVENT_SORT: NonNullable<QueryInput['sort']> = [
  { field: 'occurredAt', direction: 'desc' },
];

const builtIn = (
  name: EventListColumn,
  label: string,
  description: string,
  rest: Pick<FieldView, 'type' | 'settings' | 'isFilterable'>,
): FieldView => ({
  name,
  label,
  description,
  readOnly: true,
  owner: 'system',
  isProtected: true,
  isNullable: name !== 'occurredAt',
  isUnique: false,
  isSearchable: false,
  ...rest,
});

/**
 * Event list columns as fields, so the grid, column menu, sort and filter
 * treat them like any other: read-only, and filterable and sortable where
 * the query engine takes them (`occurredAt`, `channel`, `externalId`).
 * Participants and `about` read as relations to any entity (C4).
 */
export function eventColumnFields(schema: Pick<SchemaDescription, 'objects'>): FieldView[] {
  // Links to events from before C4 still read, since a relation displays what
  // its references name; pickers offer entities only.
  const anyEntity = {
    relationCardinality: 'many_to_many' as const,
    targetObjects: schema.objects.filter((o) => o.class !== 'event').map((o) => o.nameSingular),
  };
  return [
    builtIn('occurredAt', 'Occurred', 'When it happened', {
      type: 'date_time',
      settings: {},
      isFilterable: true,
    }),
    builtIn('participants', 'Participants', 'Who took part: matched records and other handles', {
      type: 'relation',
      settings: anyEntity,
      isFilterable: false,
    }),
    builtIn('about', 'About', 'Records the event concerns', {
      type: 'relation',
      settings: anyEntity,
      isFilterable: false,
    }),
    builtIn('channel', 'Source', 'Where it was logged from, e.g. gmail or zoom', {
      type: 'text',
      settings: {},
      isFilterable: true,
    }),
    builtIn('externalId', 'External ID', 'Its ID in that source', {
      type: 'text',
      settings: {},
      isFilterable: true,
    }),
  ];
}

/** One built-in event column as a field, e.g. `about` for a relation to any entity. */
export const eventColumnField = (
  schema: Pick<SchemaDescription, 'objects'>,
  name: EventListColumn,
): FieldView => eventColumnFields(schema).find((f) => f.name === name) as FieldView;

/** An event type as its list shows it: its fields, then the built-in columns. */
export function eventListObject(
  object: ObjectView,
  schema: Pick<SchemaDescription, 'objects'>,
): ObjectView {
  if (object.class !== 'event') return object;
  const taken = new Set(object.fields.map((f) => f.name));
  return {
    ...object,
    fields: [...object.fields, ...eventColumnFields(schema).filter((f) => !taken.has(f.name))],
  };
}

/** A conversation's `medium` select (its kind), found by base field so a rename keeps it. */
export const mediumField = (object: ObjectView | undefined) =>
  object?.fields.find((f) => f.baseField === 'conversationMedium' && f.type === 'select');

/** A conversation's medium as its option's label, if set. */
export function eventMedium(
  object: ObjectView | undefined,
  record: Pick<PresentedRecord, 'fields'>,
): string | undefined {
  const field = mediumField(object);
  const value = field ? record.fields[field.name] : undefined;
  if (!field || typeof value !== 'string' || !value) return undefined;
  return field.settings.options?.find((o) => o.value === value)?.label ?? value;
}

/**
 * The columns an event list shows by default, after the title: when it
 * happened, the type's own fields (`medium` first), participants, `about`
 * and the source. The summary is available but hidden.
 */
export function eventColumnOrder(object: ObjectView): string[] {
  const own = object.fields
    .filter(
      (f) =>
        f.type !== 'json' &&
        !f.readOnly &&
        f.name !== object.labelField &&
        f.coreRole !== 'summary' &&
        !isEventColumn(f.name),
    )
    .map((f) => f.name);
  const medium = mediumField(object)?.name;
  return [
    'occurredAt',
    ...(medium ? [medium] : []),
    ...own.filter((n) => n !== medium),
    'participants',
    'about',
    'channel',
  ];
}

/**
 * A record with its event's built-in columns and links copied into `fields`
 * under the column names, so the grid and calendar read them like fields.
 * Participants are their matched records; other handles stay on `event`.
 */
export function withEventValues<T extends PresentedRecord>(record: T): T {
  const e = record.event;
  if (!e) return record;
  return {
    ...record,
    fields: {
      ...record.fields,
      occurredAt: e.occurredAt,
      participants: e.participants.matched.map((p) => p.recordId),
      about: e.about,
      channel: e.channel,
      externalId: e.externalId,
    },
  };
}

/** The operators the query engine takes on a built-in column; fields keep their own. */
export function listFilterOperators(field: FieldView): readonly string[] {
  if (!isEventColumn(field.name) || !field.readOnly) return filterOperatorsFor(field);
  return field.type === 'date_time' ? ['gte', 'lt', 'gt', 'lte', 'eq'] : ['eq', 'neq'];
}

/**
 * The calendar an event list offers without a saved view (`?layout=calendar`):
 * every event on the day it happened. Not stored; the grid's filter applies.
 */
export function occurredCalendar(object: ObjectView): SavedView {
  const nobody = { type: 'system' as const, id: 'retainer' };
  return {
    id: '',
    object: object.nameSingular,
    name: 'Calendar',
    kind: 'calendar',
    visibility: 'workspace',
    position: 0,
    filter: null,
    sort: null,
    columns: null,
    groupBy: null,
    hiddenGroups: [],
    groupAggregate: null,
    dateField: 'occurredAt',
    createdBy: nobody,
    updatedBy: nobody,
    createdAt: '',
    updatedAt: '',
    issues: [],
  };
}

/**
 * Participants: matched records linked, then other handles. Compact (a grid
 * cell) fits as many of both as the column holds on one line and counts the
 * rest; otherwise every handle is listed.
 */
export function ParticipantsCell({
  record,
  references,
  field,
  compact = true,
}: {
  record: PresentedRecord;
  references?: Record<string, RecordReference>;
  field: FieldView;
  compact?: boolean;
}) {
  const workspace = useContext(WorkspaceContext);
  const unmatched = record.event?.participants.unmatched ?? [];
  const matched = record.event?.participants.matched ?? [];
  if (compact)
    return (
      <FitList
        items={[
          ...relationItems(
            field,
            matched.map((p) => p.recordId),
            references ?? {},
            workspace,
          ),
          ...unmatched.map((p) => ({
            key: `unmatched\u0000${p.id}`,
            node: <Muted small>{p.handle || 'Unknown'}</Muted>,
          })),
        ]}
      />
    );
  const Display = fields.relation.Display;
  return (
    <>
      {matched.length ? (
        <Display field={field} value={matched.map((p) => p.recordId)} references={references} />
      ) : null}
      {unmatched.length ? (
        <Muted small>{unmatched.map((p) => p.handle || 'Unknown').join(', ')}</Muted>
      ) : null}
    </>
  );
}

/**
 * Why an event list has no New button: one muted line, with a help popover
 * naming the tool and route that log events.
 */
export function LoggedByAgents() {
  return (
    <Popover
      label="How events are logged"
      align="end"
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Logged by agents and integrations.
          <CircleHelp size={13} aria-hidden />
        </button>
      }
    >
      <PanelBody>
        <Stack gap="small">
          <Muted>
            Events are written by agents and integrations as they happen, not created here. An agent
            logs one with the MCP tool <Code>log_event</Code>; an integration sends{' '}
            <Code>POST /v1/events</Code>. Logging the same source and external ID again adds to the
            same event.
          </Muted>
        </Stack>
      </PanelBody>
    </Popover>
  );
}
