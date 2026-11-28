import type {
  AgentBriefing,
  FieldView,
  ObjectView,
  ProfileContextPack,
  SchemaDescription,
} from '@retainer/shared';
import { isInverseRelation } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BookOpen,
  Brain,
  FileText,
  Lightbulb,
  type LucideIcon,
  Shapes,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useAccount } from '../../accounts/context.js';
import { api, useWorkspace } from '../../api/client.js';
import { ActorBadge } from '../../provenance/index.js';
import {
  Code,
  Entry,
  EntryList,
  EntryText,
  EntryTime,
  Markdown,
  Muted,
  NavItem,
  NavList,
  Page,
  Row,
  SplitView,
  Table,
  Td,
  Tr,
} from '../../ui/index.js';
import { CONTEXT_BUDGETS } from '../records/agent-context.js';
import { QueryError } from '../state.js';

type SectionId = 'instructions' | 'memory' | 'schema' | 'missing' | 'tools' | 'guides';
/** The page's sections, in order: each heading, and its entry in the list at the side. */
const SECTIONS: { id: SectionId; title: string; icon: LucideIcon }[] = [
  { id: 'instructions', title: 'Connection instructions', icon: FileText },
  { id: 'memory', title: 'Memory read at the start', icon: Brain },
  { id: 'schema', title: 'Schema as the agent reads it', icon: Shapes },
  { id: 'missing', title: 'Missing descriptions', icon: TriangleAlert },
  { id: 'tools', title: 'Tools', icon: Wrench },
  { id: 'guides', title: 'Guides', icon: BookOpen },
];
const sectionTitle = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.title ?? id;

/** An object or field with no description, as §6.4 lists them. */
export type MissingDescriptions = {
  object: ObjectView;
  /** Whether the object itself has none. */
  objectMissing: boolean;
  fields: FieldView[];
}[];

const blank = (text: string | null | undefined) => !text?.trim();

/**
 * Objects and fields with no description, grouped by object (agent view spec
 * §6.4). Inverse relation fields are left out: they are read only and
 * described by their other side.
 */
export function missingDescriptions(schema: Pick<SchemaDescription, 'objects'>) {
  const groups: MissingDescriptions = [];
  for (const object of schema.objects) {
    const fields = object.fields.filter((f) => !isInverseRelation(f) && blank(f.description));
    const objectMissing = blank(object.description);
    if (objectMissing || fields.length) groups.push({ object, objectMissing, fields });
  }
  return groups;
}
/** How many items the missing-descriptions list holds. */
export const missingCount = (groups: MissingDescriptions) =>
  groups.reduce((n, g) => n + g.fields.length + (g.objectMissing ? 1 : 0), 0);

/** A tool's description up to the end of its first sentence; "e.g." and "i.e." don't end one. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  for (const match of trimmed.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1;
    if (!/\b(?:e\.g|i\.e)\.$/i.test(trimmed.slice(0, end))) return trimmed.slice(0, end);
  }
  return trimmed;
}

/** A JSON Schema property's type, as a short word. */
function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'unknown';
  if (typeof schema.type === 'string')
    return schema.type === 'array'
      ? `array of ${schemaType(schema.items as Record<string, unknown> | undefined)}`
      : schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  const union = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(union)) return [...new Set(union.map(schemaType))].join(' | ');
  return 'any';
}

/** A tool's inputs: name, type, whether required, and the input's own description. */
export function toolInputs(inputSchema: Record<string, unknown>) {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((inputSchema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: schemaType(schema),
    required: required.has(name),
    description: typeof schema.description === 'string' ? schema.description : '',
  }));
}

/** A field's options or target, for the schema table. */
function fieldOptions(field: FieldView): string {
  const s = field.settings;
  if (s.options?.length) return s.options.map((o) => o.value).join(', ');
  if (s.targetObjects?.length) return `→ ${s.targetObjects.join(' | ')}`;
  if (s.targetObject) return `→ ${s.targetObject}${s.isInverse ? ' (read only)' : ''}`;
  return '';
}

/**
 * The "What agents are told" page (agent view spec §6): everything Retainer
 * gives an agent that is not about one record. Read only; each part comes from
 * the same source the agent gets it from.
 */
export function BriefingPage() {
  const { session, schema } = useWorkspace();
  const account = useAccount();
  const briefing = useQuery({
    queryKey: ['agent-briefing'],
    queryFn: ({ signal }) => api.agentBriefing(signal),
    // It changes only with a deploy.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const profiles = schema.builtIns.find((b) => b.name === 'memory')?.profiles ?? ['workspace'];
  const missing = useMemo(() => missingDescriptions(schema), [schema]);
  const missingTotal = missingCount(missing);
  return (
    <Page title="What agents are told" eyebrow="Agent view">
      <p className="m-0 max-w-prose text-sm text-secondary-foreground">
        This is what Retainer gives an agent that connects to this workspace. The agent also has its
        own instructions and tools from the app it runs in; Retainer cannot see those.
      </p>
      <SplitView
        nav={
          <NavList label="Sections">
            {SECTIONS.map((s) => (
              <NavItem
                key={s.id}
                icon={s.icon}
                label={s.title}
                {...(s.id === 'missing' ? { meta: missingTotal } : {})}
                onSelect={() => jumpTo(s.id)}
              />
            ))}
          </NavList>
        }
      >
        <BriefingSection id="instructions">
          <Muted small>The text every agent gets when it connects, in full.</Muted>
          {briefing.data ? (
            <pre className="m-0 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {briefing.data.instructions}
            </pre>
          ) : (
            <BriefingState query={briefing} />
          )}
        </BriefingSection>
        <BriefingSection id="memory">
          <Muted small>
            What get_context returns for workspace memory
            {profiles.includes('me') ? ' and your personal memory' : ''}, at the default budget.
            {account ? (
              <>
                {' '}
                Facts are removed in{' '}
                <Link to="/settings" search={{ tab: 'memory' }} className="underline">
                  Settings → Memory
                </Link>
                .
              </>
            ) : null}
          </Muted>
          <ProfileMemory profile="workspace" workspaceId={session.workspace.id} />
          {profiles.includes('me') ? (
            <ProfileMemory profile="me" workspaceId={session.workspace.id} />
          ) : null}
        </BriefingSection>
        <BriefingSection id="schema">
          <SchemaAsRead schema={schema} />
        </BriefingSection>
        <BriefingSection id="missing" count={missingTotal}>
          <Muted small>
            Without a description, an agent has only the field’s name to decide what belongs in it.
          </Muted>
          {missing.length ? (
            <ul aria-label="Missing descriptions" className="m-0 flex list-none flex-col gap-3 p-0">
              {missing.map((group) => (
                <li key={group.object.nameSingular} className="flex flex-col gap-1 text-sm">
                  <SchemaLink object={group.object.nameSingular}>
                    {group.object.labelSingular} <Code>{group.object.nameSingular}</Code>
                    {group.objectMissing ? <Muted small> · the object itself</Muted> : null}
                  </SchemaLink>
                  {group.fields.length ? (
                    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0 pl-3">
                      {group.fields.map((f) => (
                        <li key={f.name}>
                          <SchemaLink object={group.object.nameSingular} field={f.name}>
                            <Code>{f.name}</Code>
                          </SchemaLink>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Muted small>Every object and field has a description.</Muted>
          )}
        </BriefingSection>
        <BriefingSection id="tools">
          {briefing.data ? (
            <Tools tools={briefing.data.tools} />
          ) : (
            <BriefingState query={briefing} />
          )}
        </BriefingSection>
        <BriefingSection id="guides">
          {briefing.data ? (
            <div className="flex flex-col gap-2">
              {briefing.data.guides.map((guide) => (
                <Disclosure
                  key={guide.name}
                  summary={
                    <>
                      <Code>{guide.name}</Code>
                      <span className="text-muted-foreground">{guide.description}</span>
                    </>
                  }
                >
                  {() => <Markdown>{guide.markdown}</Markdown>}
                </Disclosure>
              ))}
            </div>
          ) : (
            <BriefingState query={briefing} />
          )}
        </BriefingSection>
      </SplitView>
    </Page>
  );
}

/** Scrolls to a section and moves focus there, so keyboard users continue from it. */
function jumpTo(id: SectionId) {
  const section = document.getElementById(`briefing-${id}`);
  section?.scrollIntoView({ block: 'start' });
  section?.focus({ preventScroll: true });
}

function BriefingSection({
  id,
  count,
  children,
}: {
  id: SectionId;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section
      id={`briefing-${id}`}
      aria-labelledby={`briefing-${id}-title`}
      tabIndex={-1}
      className="flex scroll-mt-16 flex-col gap-3 outline-none"
    >
      <h2 id={`briefing-${id}-title`} className="m-0 text-base font-semibold">
        {sectionTitle(id)}
        {count === undefined ? '' : ` (${count})`}
      </h2>
      {children}
    </section>
  );
}

function BriefingState({ query }: { query: { error: Error | null; refetch: () => unknown } }) {
  return query.error ? (
    <QueryError error={query.error} retry={() => void query.refetch()} />
  ) : (
    <Muted small>Loading…</Muted>
  );
}

/**
 * A row that opens in place to show the rest. The rest is rendered only once
 * opened, so a long list of closed rows stays cheap.
 */
function Disclosure({ summary, children }: { summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-lg border border-border"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]">
        {summary}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3 text-sm">
        {open ? children() : null}
      </div>
    </details>
  );
}

function SchemaLink({
  object,
  field,
  children,
}: {
  object: string;
  field?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/schema"
      search={{ object, ...(field ? { field } : {}) }}
      className="inline-flex flex-wrap items-baseline gap-1 hover:underline"
    >
      {children}
    </Link>
  );
}

/** A profile's memory as `get_context` returns it at the default budget. */
function ProfileMemory({
  profile,
  workspaceId,
}: {
  profile: 'workspace' | 'me';
  workspaceId: string;
}) {
  const budget = CONTEXT_BUDGETS[0];
  const query = useQuery({
    queryKey: [workspaceId, 'agent-context', profile, budget],
    queryFn: ({ signal }) =>
      api.context(profile, { tokenBudget: budget }, signal) as Promise<ProfileContextPack>,
    staleTime: 60_000,
  });
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="m-0 text-xs font-semibold text-muted-foreground">
        <Code>{profile}</Code>
      </h3>
      {!query.data ? (
        <BriefingState query={query} />
      ) : query.data.facts.length ? (
        <EntryList label={`${profile} memory`}>
          {query.data.facts.map((fact) => (
            <Entry
              key={fact.id}
              icon={Lightbulb}
              title={<ActorBadge actor={fact.writtenBy} />}
              time={<EntryTime at={fact.validFrom} label="Valid from" />}
            >
              <EntryText>{fact.content}</EntryText>
            </Entry>
          ))}
        </EntryList>
      ) : (
        <Muted small>No facts.</Muted>
      )}
      {query.data?.omitted.facts ? (
        <Muted small>
          {query.data.omitted.facts} more {query.data.omitted.facts === 1 ? 'fact' : 'facts'} did
          not fit.
        </Muted>
      ) : null}
    </div>
  );
}

function SchemaAsRead({ schema }: { schema: SchemaDescription }) {
  return (
    <div className="flex flex-col gap-6">
      {schema.objects.map((object) => (
        <div key={object.nameSingular} className="flex flex-col gap-2">
          <Row>
            <SchemaLink object={object.nameSingular}>
              <Code>{object.nameSingular}</Code>
            </SchemaLink>
            <Muted small>{object.class}</Muted>
          </Row>
          {blank(object.description) ? (
            <Muted small>No description.</Muted>
          ) : (
            <p className="m-0 text-sm">{object.description?.trim()}</p>
          )}
          <Table
            label={`Fields of ${object.nameSingular}`}
            headers={[
              { label: 'API name' },
              { label: 'Type' },
              { label: 'Options' },
              { label: 'Description' },
            ]}
          >
            {object.fields.map((f) => (
              <Tr key={f.name}>
                <Td first>
                  <SchemaLink object={object.nameSingular} field={f.name}>
                    <Code>{f.name}</Code>
                  </SchemaLink>
                </Td>
                <Td>
                  <Code>{f.type}</Code>
                </Td>
                <Td>{fieldOptions(f) ? <Code>{fieldOptions(f)}</Code> : null}</Td>
                <Td>{blank(f.description) ? <Muted>—</Muted> : f.description?.trim()}</Td>
              </Tr>
            ))}
          </Table>
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">Built-ins</h3>
        {schema.builtIns.map((b) => (
          <div key={b.name} className="flex flex-col gap-1 text-sm">
            <Row>
              <Code>{b.name}</Code>
              <Muted small>{b.labelPlural}</Muted>
            </Row>
            <p className="m-0">{b.description}</p>
          </div>
        ))}
      </div>
      {Object.keys(schema.valueFormats).length ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Value formats</h3>
          <dl className="m-0 flex flex-col gap-1.5 text-sm">
            {Object.entries(schema.valueFormats).map(([type, format]) => (
              <div key={type} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="shrink-0 font-mono text-xs sm:w-28">{type}</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">{format}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Tools({ tools }: { tools: AgentBriefing['tools'] }) {
  return (
    <div className="flex flex-col gap-2">
      {tools.map((tool) => (
        <Disclosure
          key={tool.name}
          summary={
            <>
              <Code>{tool.name}</Code>
              {/* The full description shows once the row is open. */}
              <span className="text-muted-foreground group-open:hidden">
                {firstSentence(tool.description)}
              </span>
            </>
          }
        >
          {() => <ToolDetails tool={tool} />}
        </Disclosure>
      ))}
    </div>
  );
}

function ToolDetails({ tool }: { tool: AgentBriefing['tools'][number] }) {
  const inputs = toolInputs(tool.inputSchema);
  return (
    <>
      <p className="m-0 whitespace-pre-line">{tool.description}</p>
      {inputs.length ? (
        <Table
          label={`Inputs of ${tool.name}`}
          headers={[
            { label: 'Input' },
            { label: 'Type' },
            { label: 'Required' },
            { label: 'Description' },
          ]}
        >
          {inputs.map((input) => (
            <Tr key={input.name}>
              <Td first>
                <Code>{input.name}</Code>
              </Td>
              <Td>
                <Code>{input.type}</Code>
              </Td>
              <Td>{input.required ? 'Yes' : 'No'}</Td>
              <Td>{input.description}</Td>
            </Tr>
          ))}
        </Table>
      ) : (
        <Muted small>No inputs.</Muted>
      )}
    </>
  );
}
