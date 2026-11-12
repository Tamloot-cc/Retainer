import type {
  EventDetails,
  ObjectView,
  RecordReference,
  SchemaDescription,
  UnmatchedReason,
  Via,
} from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Form,
  FormField,
  Input,
  Muted,
  Notice,
  Property,
  PropertyList,
  Row,
  Stack,
} from '../../ui/index.js';
import { useApiName } from '../developer.js';
import { CandidateRecord } from '../records/record-actions.js';
import {
  objectByName,
  objectLabel,
  recordTitle,
  relationsTo,
  useDebounced,
  useRecordLabel,
} from '../state.js';

export const REASONS: Record<UnmatchedReason, string> = {
  no_match: 'No matching record',
  phone_only: 'Phone only',
  deleted_record: 'Deleted record',
  ambiguous: 'Several possible records',
  suppressed: 'Blocked after erasure',
};

/**
 * How an event is attached to the record whose history lists it (7.1):
 * a participant, `about` it, through one of the event's relation fields, or
 * rolled up from a related record. A rollup reads as a sentence with a link,
 * not a badge, since the event isn't attached to this record itself.
 */
export function ViaLabel({
  via,
  eventObject,
  recordObject,
  references,
}: {
  via: Via;
  /** The event type, to name a relation field the event points through. */
  eventObject?: ObjectView;
  /** The listing record's object, to name the field a rollup follows. */
  recordObject?: ObjectView;
  /**
   * The page's map of the records its events name. Given, a rollup's source
   * record is named from it; otherwise it is fetched.
   */
  references?: Record<string, RecordReference>;
}): ReactNode {
  switch (via.kind) {
    case 'participant':
      return <Badge>Participant</Badge>;
    case 'about':
      return <Badge>About</Badge>;
    case 'field':
      return <Badge>Via field {fieldLabel(eventObject, via.field)}</Badge>;
    case 'rollup':
      return references ? (
        <RollupVia via={via} recordObject={recordObject} references={references} />
      ) : (
        <FetchedRollupVia via={via} recordObject={recordObject} />
      );
    default:
      return unknownVia(via);
  }
}
/** Fails to compile when a `Via` kind has no case above; shows nothing at run time. */
function unknownVia(via: never): null {
  void via;
  return null;
}
const fieldLabel = (object: ObjectView | undefined, name: string) =>
  object?.fields.find((f) => f.name === name)?.label ?? name;

type RollupProps = { via: Extract<Via, { kind: 'rollup' }>; recordObject?: ObjectView };

/**
 * "Rolled up via Company of Dana Levi". `via.field` is a field of the source
 * record, named from that record's object as `references` gives it. A source
 * missing from the map shows as unavailable, and its field is guessed.
 */
function RollupVia({
  via,
  recordObject,
  references,
}: RollupProps & { references: Record<string, RecordReference> }) {
  const { schema } = useWorkspace();
  const source = references[via.record];
  const label = source
    ? fieldLabel(objectByName(schema, source.object), via.field)
    : guessRollupField(schema, via.field, recordObject);
  return (
    <RollupSentence label={label}>
      <CandidateRecord id={via.record} references={references} />
    </RollupSentence>
  );
}

/**
 * A rollup where no references map is at hand (the timeline): the source
 * record is fetched (the query `CandidateRecord` shares), and its field is
 * guessed until the record's object is known.
 */
function FetchedRollupVia({ via, recordObject }: RollupProps) {
  const { schema } = useWorkspace();
  const source = useRecordLabel(via.record);
  const sourceObject = source.data ? objectByName(schema, source.data.object) : undefined;
  const label = sourceObject
    ? fieldLabel(sourceObject, via.field)
    : guessRollupField(schema, via.field, recordObject);
  return (
    <RollupSentence label={label}>
      <CandidateRecord id={via.record} />
    </RollupSentence>
  );
}

/**
 * A rollup's field when its source object is unknown: the one owning relation
 * of that name that points at `recordObject`, if there is exactly one.
 */
function guessRollupField(schema: SchemaDescription, name: string, recordObject?: ObjectView) {
  const candidates = recordObject
    ? schema.objects.flatMap((o) =>
        relationsTo(o.fields, recordObject.nameSingular).filter((f) => f.name === name),
      )
    : [];
  return candidates.length === 1 ? (candidates[0]?.label ?? name) : name;
}

function RollupSentence({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-sm italic text-muted-foreground">
      <CornerDownRight size={13} aria-hidden className="shrink-0" />
      <span>Rolled up via {label} of</span> {children}
    </span>
  );
}

/**
 * An event's built-in columns, participants and `about` records. With
 * `editable`, links can be added and removed (a person's key only).
 */
export function EventDetailsView({
  id,
  event,
  editable: allowEditing,
  medium,
  mediumName = 'medium',
}: {
  id: string;
  event: EventDetails;
  editable: boolean;
  /** The conversation's medium (meeting, call…), shown when set. */
  medium?: string;
  /** The medium field's API name, for Developer view; it may have been renamed. */
  mediumName?: string;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient(),
    apiName = useApiName();
  const editable = allowEditing && !event.source;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  /** Runs one link change and refreshes; true when it succeeded. */
  async function change(run: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await run();
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const { matched, unmatched } = event.participants;
  const remove = (label: string, run: () => Promise<unknown>) =>
    editable ? (
      <Button
        variant="ghost"
        size="iconSmall"
        disabled={busy}
        aria-label={`Remove ${label}`}
        title="Remove"
        onClick={() => void change(run)}
      >
        <X size={13} />
      </Button>
    ) : null;
  return (
    <Stack>
      {event.source ? (
        <Notice>
          {event.source.current
            ? 'This is the current provider revision. Edits are imported as new evidence.'
            : 'This provider revision was superseded. Existing citations remain available in history.'}
          {event.source.previousEventId ? (
            <>
              {' '}
              Previous evidence: <CandidateRecord id={event.source.previousEventId} />.
            </>
          ) : null}
        </Notice>
      ) : null}
      {error ? <Notice error>{error}</Notice> : null}
      <PropertyList>
        <Property label="Occurred" apiName={apiName('occurredAt')}>
          {new Date(event.occurredAt).toLocaleString()}
        </Property>
        {medium ? (
          <Property label="Medium" apiName={apiName(mediumName)}>
            <Badge>{medium}</Badge>
          </Property>
        ) : null}
        <Property label="Source" apiName={apiName('channel')}>
          {event.channel ?? <Muted>Erased for privacy</Muted>}
        </Property>
        <Property label="External ID" apiName={apiName('externalId')}>
          {event.externalId ?? <Muted>{event.channel ? 'None' : 'Erased for privacy'}</Muted>}
        </Property>
        <Property label="Participants" apiName={apiName('participants')}>
          <Stack>
            {matched.map((p) => (
              <Row key={p.id}>
                <CandidateRecord id={p.recordId} />
                {p.handle ? <Muted>{p.handle}</Muted> : null}
                {p.role ? <Badge>{p.role}</Badge> : null}
                {remove(p.handle || 'participant', () => api.removeParticipant(id, p.id))}
              </Row>
            ))}
            {unmatched.map((p) => (
              <Row key={p.id}>
                <span>{p.handle || 'Unknown participant'}</span>
                <Badge tone="pending">{REASONS[p.reason] ?? p.reason}</Badge>
                {p.role ? <Badge>{p.role}</Badge> : null}
                {p.candidates?.map((candidate) => (
                  <CandidateRecord key={candidate} id={candidate} />
                ))}
                {remove(p.handle || 'participant', () => api.removeParticipant(id, p.id))}
              </Row>
            ))}
            {!matched.length && !unmatched.length ? <Muted>No participants</Muted> : null}
            {editable ? (
              <AddParticipant
                busy={busy}
                onAdd={(handle, role) =>
                  change(() =>
                    api.addEventLinks(id, {
                      participants: [{ handle, ...(role ? { role } : {}) }],
                    }),
                  )
                }
              />
            ) : null}
          </Stack>
        </Property>
        <Property label="About" apiName={apiName('about')}>
          <Stack>
            {event.about.map((record) => (
              <Row key={record}>
                <CandidateRecord id={record} />
                {remove('about record', () => api.removeAbout(id, record))}
              </Row>
            ))}
            {!event.about.length ? <Muted>Not about any record</Muted> : null}
            {editable ? (
              <AddAbout
                busy={busy}
                exclude={[id, ...event.about]}
                onAdd={(record) => change(() => api.addEventLinks(id, { about: [record] }))}
              />
            ) : null}
          </Stack>
        </Property>
      </PropertyList>
    </Stack>
  );
}

function AddParticipant({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (handle: string, role: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false),
    [handle, setHandle] = useState(''),
    [role, setRole] = useState('');
  if (!open)
    return (
      <Row>
        <Button size="small" variant="ghost" onClick={() => setOpen(true)}>
          Add participant…
        </Button>
      </Row>
    );
  return (
    <Form
      autoFocus
      onSubmit={() => {
        if (!handle.trim()) return;
        void onAdd(handle.trim(), role.trim()).then((added) => {
          if (!added) return;
          setHandle('');
          setRole('');
          setOpen(false);
        });
      }}
    >
      <FormField label="Email or phone">
        <Input
          aria-label="Participant email or phone"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
      </FormField>
      <FormField label="Role" hint="Optional">
        <Input
          aria-label="Participant role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </FormField>
      <Row>
        <Button type="submit" variant="primary" size="small" disabled={busy || !handle.trim()}>
          Add participant
        </Button>
        <Button size="small" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Row>
    </Form>
  );
}

/** Finds an entity by keyword (`POST /v1/search`) to mark the event as about it. */
export function AddAbout({
  busy,
  exclude,
  onAdd,
}: {
  busy: boolean;
  exclude: string[];
  onAdd: (record: string) => Promise<boolean>;
}) {
  const { session, schema } = useWorkspace();
  const [open, setOpen] = useState(false),
    [text, setText] = useState('');
  const query = useDebounced(text.trim());
  const results = useQuery({
    queryKey: [session.workspace.id, 'search', query],
    enabled: open && !!query,
    queryFn: ({ signal }) => api.search({ query, limit: 8 }, signal),
  });
  if (!open)
    return (
      <Row>
        <Button size="small" variant="ghost" onClick={() => setOpen(true)}>
          Add record…
        </Button>
      </Row>
    );
  // `about` names entities only (C4), so events are not offered.
  const hits = (
    query && results.data
      ? results.data.records.map((h) => ({ id: h.id, title: recordTitle(h), object: h.object }))
      : []
  ).filter((h) => !exclude.includes(h.id));
  return (
    <Stack>
      <Input
        autoFocus
        aria-label="Find a record"
        placeholder="Find a record…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {hits.map((hit) => (
        <Button
          key={hit.id}
          size="small"
          disabled={busy}
          onClick={() =>
            void onAdd(hit.id).then((added) => {
              if (!added) return;
              setText('');
              setOpen(false);
            })
          }
        >
          {hit.title}
          <Muted>{objectLabel(schema, hit.object)}</Muted>
        </Button>
      ))}
      {query && results.data && !hits.length ? <Muted>No records match.</Muted> : null}
      <Row>
        <Button size="small" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  );
}
