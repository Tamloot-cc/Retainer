import type { BuiltInView, EventColumn, ObjectView } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Brain,
  KeyRound,
  Lightbulb,
  Lock,
  type LucideIcon,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  CardGrid,
  Check,
  Code,
  Empty,
  EntityHeader,
  Input,
  Muted,
  NavItem,
  NavList,
  Notice,
  objectIcon,
  Panel,
  Property,
  PropertyList,
  Row,
  Section,
  SplitView,
  Stack,
  Table,
  Td,
  TextButton,
  Tooltip,
  Tr,
} from '../../ui/index.js';
import { objectByName, QueryError, sortObjects, useView } from '../state.js';
import { FieldSheet, FLAGS } from './field-sheet.js';
import { CORE_ROLE_TEXT, FieldTypeLabel, OwnerBadge } from './schema-labels.js';
import { matchesField, typeDetail } from './schema-model.js';

/** The built-in columns every event record has beside its fields. */
const EVENT_COLUMN_INFO: Record<EventColumn, { label: string; description: string }> = {
  occurredAt: { label: 'Occurred at', description: 'When it happened' },
  channel: {
    label: 'Source',
    description: 'The source system or account, e.g. gmail or zoom; part of its identity',
  },
  externalId: {
    label: 'External ID',
    description: 'Its ID in that channel; logging it again adds to the same event',
  },
};

const BUILT_IN_ICONS: Record<BuiltInView['name'], LucideIcon> = {
  fact: Lightbulb,
  comment: MessageSquare,
  memory: Brain,
};

export function ObjectsTab() {
  const { session, schema } = useWorkspace(),
    { search, setSearch } = useView();
  const objects = sortObjects(schema.objects);
  const { builtIns } = schema;
  const named = builtIns.find((b) => b.name === search.object);
  const object = named ? undefined : (objectByName({ objects }, search.object) ?? objects[0]);
  // With no objects yet, the built-ins are still there to look at.
  const builtIn = named ?? (object ? undefined : builtIns[0]);
  const field = object?.fields.find((f) => f.name === search.field);
  const select = (object: string, field?: string) => void setSearch({ object, field });
  const entities = objects.filter((o) => o.class !== 'event'),
    eventTypes = objects.filter((o) => o.class === 'event');
  const navItem = (o: ObjectView) => (
    <NavItem
      key={o.nameSingular}
      icon={objectIcon(o.nameSingular, o.class)}
      label={o.labelPlural}
      meta={o.fields.length}
      active={o.nameSingular === object?.nameSingular}
      onSelect={() => select(o.nameSingular)}
    />
  );
  return (
    <>
      {!schema.workspace.templates.length ? <TemplatePicker /> : null}
      <ClassIntro />
      {objects.length ? null : (
        <Empty
          title="No objects yet"
          description={
            canMutate(session, 'schema:write')
              ? 'Apply a template above, or let an agent propose objects.'
              : 'Objects appear here once a template is applied or an agent’s proposal is approved.'
          }
        />
      )}
      {object || builtIn ? (
        <SplitView
          nav={
            <>
              {entities.length ? <NavList label="Records">{entities.map(navItem)}</NavList> : null}
              {eventTypes.length ? (
                <NavList label="Activity">{eventTypes.map(navItem)}</NavList>
              ) : null}
              {builtIns.length ? (
                <NavList label="Built-in">
                  {builtIns.map((b) => (
                    <NavItem
                      key={b.name}
                      icon={BUILT_IN_ICONS[b.name]}
                      label={b.labelPlural}
                      meta={b.fields.length}
                      active={b.name === builtIn?.name}
                      onSelect={() => select(b.name)}
                    />
                  ))}
                </NavList>
              ) : null}
            </>
          }
        >
          {builtIn ? (
            <BuiltInDetail builtIn={builtIn} />
          ) : object ? (
            <ObjectDetail
              key={object.nameSingular}
              object={object}
              selectedField={field?.name}
              onOpenField={(name) => select(object.nameSingular, name)}
            />
          ) : null}
        </SplitView>
      ) : null}
      {object && field ? (
        <FieldSheet
          object={object}
          field={field}
          onClose={() => void setSearch({ field: undefined })}
          onNavigate={select}
        />
      ) : null}
    </>
  );
}

/**
 * What the two classes are and how each is written, above the object list
 * (5.8): a record is kept up to date; an event happened once.
 */
function ClassIntro() {
  return (
    <CardGrid>
      <Panel title="Records">
        <Muted>
          Records are the things the workspace keeps track of: people, companies, deals. Each holds
          fields that change over time, and every value keeps who wrote it and why. Agents write
          them with <Code>upsert_record</Code> (<Code>POST /v1/objects/:object/upsert</Code>), and
          people create and edit them here.
        </Muted>
      </Panel>
      <Panel title="Activity">
        <Muted>
          Events are what happened: conversations, notes and anything else with a time. Each has a
          source, participants and the records it is about, and is the evidence values and facts
          cite. Agents and integrations log them with <Code>log_event</Code> (
          <Code>POST /v1/events</Code>); logging the same source and ID again adds to the same
          event. People write notes here.
        </Muted>
      </Panel>
    </CardGrid>
  );
}

/**
 * Facts: part of every workspace and fixed by Retainer, so there is nothing
 * to change here; agents write them through their own tools.
 */
function BuiltInDetail({ builtIn }: { builtIn: BuiltInView }) {
  return (
    <>
      <EntityHeader
        icon={BUILT_IN_ICONS[builtIn.name]}
        title={builtIn.labelPlural}
        meta={
          <>
            <Code>{builtIn.name}</Code>
            <Badge>Built in</Badge>
          </>
        }
        description={builtIn.description}
      />
      <Table headers={[{ label: 'Field' }, { label: 'Type' }, { label: 'Description' }]}>
        {builtIn.fields.map((f) => (
          <Tr key={f.name}>
            <Td first>
              <Code>{f.name}</Code>
            </Td>
            <Td>{f.type}</Td>
            <Td>
              <Muted>{f.description}</Muted>
            </Td>
          </Tr>
        ))}
      </Table>
      <Section title="How agents use it">
        <PropertyList>
          <Property label="Written with">
            <Row>
              {builtIn.writeWith.map((tool) => (
                <Code key={tool}>{tool}</Code>
              ))}
            </Row>
          </Property>
          <Property label="Read with">
            <Row>
              {builtIn.readWith.map((tool) => (
                <Code key={tool}>{tool}</Code>
              ))}
            </Row>
          </Property>
        </PropertyList>
      </Section>
    </>
  );
}

/** Keyed by object, so the field filter starts empty for each one. */
function ObjectDetail({
  object,
  selectedField,
  onOpenField,
}: {
  object: ObjectView;
  selectedField?: string;
  onOpenField: (name: string) => void;
}) {
  const { schema } = useWorkspace();
  const [query, setQuery] = useState('');
  const label = object.fields.find((f) => f.name === object.labelField);
  const shown = object.fields.filter((f) => matchesField(f, query));
  return (
    <>
      <EntityHeader
        icon={objectIcon(object.nameSingular, object.class)}
        title={object.labelPlural}
        meta={
          <>
            <Code>{object.nameSingular}</Code>
            <Code>{object.namePlural}</Code>
            {object.class === 'event' ? <Badge>Event</Badge> : null}
            <OwnerBadge owner={object.owner} />
            {label ? <span>Records named by {label.label}</span> : null}
          </>
        }
        description={object.description}
        actions={
          <Button size="small" variant="ghost" asChild>
            <Link to="/o/$object" params={{ object: object.nameSingular }}>
              Browse records
              <ArrowUpRight size={14} aria-hidden />
            </Link>
          </Button>
        }
      />
      <Row>
        <div>
          <Input
            type="search"
            aria-label="Filter fields"
            placeholder="Filter fields…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Muted>
          {query ? `${shown.length} of ${object.fields.length}` : object.fields.length}{' '}
          {object.fields.length === 1 ? 'field' : 'fields'}
        </Muted>
      </Row>
      {shown.length ? (
        <Table
          headers={[
            { label: 'Field' },
            { label: 'Type' },
            ...FLAGS.map((f) => ({ label: f.label, align: 'center' as const })),
            { label: 'Owner' },
          ]}
        >
          {shown.map((f) => {
            const detail = typeDetail(f, schema.objects);
            return (
              <Tr
                key={f.name}
                selected={f.name === selectedField}
                onOpen={() => onOpenField(f.name)}
              >
                <Td first>
                  <Row>
                    <TextButton onClick={() => onOpenField(f.name)}>{f.label}</TextButton>
                    {f.name === object.labelField ? (
                      <Tooltip content="Names this object’s records wherever they are referenced.">
                        <KeyRound size={13} aria-label="Label field" />
                      </Tooltip>
                    ) : null}
                    {f.readOnly ? (
                      <Tooltip content="Read only: written by the server, not directly.">
                        <Lock size={13} aria-label="Read only" />
                      </Tooltip>
                    ) : null}
                    {f.coreRole || f.isProtected ? (
                      <Tooltip
                        content={
                          f.coreRole
                            ? CORE_ROLE_TEXT[f.coreRole]
                            : 'Protected: Retainer depends on it. It can be renamed but not deleted.'
                        }
                      >
                        <ShieldCheck
                          size={13}
                          aria-label={f.coreRole ? 'Core field' : 'Protected'}
                        />
                      </Tooltip>
                    ) : null}
                  </Row>
                  <Code>{f.name}</Code>
                </Td>
                <Td>
                  <FieldTypeLabel field={f} />
                  {detail ? <Muted>{detail}</Muted> : null}
                </Td>
                {FLAGS.map((flag) => (
                  <Td key={flag.label} align="center">
                    <Check value={flag.on(f)} />
                  </Td>
                ))}
                <Td>
                  <OwnerBadge owner={f.owner} />
                </Td>
              </Tr>
            );
          })}
        </Table>
      ) : (
        <Empty
          title={query ? 'No matching fields' : 'No fields'}
          description={query ? `Nothing in ${object.labelPlural} matches “${query}”.` : undefined}
        />
      )}
      {object.class === 'event' ? (
        <Section title="Event columns">
          <Muted>
            Every {object.labelSingular.toLowerCase()} has these besides its fields. Events are
            created only by logging them (<Code>log_event</Code>), with their participants and the
            records they are about.
          </Muted>
          <PropertyList>
            {(object.eventColumns ?? []).map((c) => (
              <Property key={c} label={EVENT_COLUMN_INFO[c].label}>
                <Row>
                  <Code>{c}</Code>
                  <Muted>{EVENT_COLUMN_INFO[c].description}</Muted>
                </Row>
              </Property>
            ))}
          </PropertyList>
        </Section>
      ) : null}
    </>
  );
}

function TemplatePicker() {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const templates = useQuery({
    queryKey: [session.workspace.id, 'templates'],
    queryFn: ({ signal }) => api.templates(signal),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const allowed = canMutate(session, 'schema:write');
  async function apply(name: string) {
    setBusy(true);
    setError('');
    try {
      await api.applyTemplate(name);
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Start from a template">
      <Muted>
        {schema.objects.length
          ? 'A template adds the objects and fields for a kind of work. Agents can extend it later.'
          : 'This workspace has no objects yet. A template adds the objects and fields for a kind of work.'}
      </Muted>
      {error ? <Notice error>{error}</Notice> : null}
      {templates.error ? <QueryError error={templates.error} /> : null}
      <CardGrid>
        {templates.data?.templates.map((t) => (
          <Panel key={t.name} title={t.label}>
            <Stack>
              <Muted>{t.description}</Muted>
              {allowed ? (
                <Row>
                  <Button variant="primary" disabled={busy} onClick={() => void apply(t.name)}>
                    Apply {t.label}
                  </Button>
                </Row>
              ) : null}
            </Stack>
          </Panel>
        ))}
      </CardGrid>
    </Section>
  );
}
