import { z } from 'zod';
import type { FieldType } from './field-types.js';

/**
 * Routines (docs/specs/routines.md): a standing instruction for a workspace,
 * written as a manifest (when it runs) and TypeScript code (what it does).
 * This module holds what the server, the runner and the web app share: the
 * manifest's shape, the limits, the run statuses, the runtime protocol and the
 * generator for the SDK types the code is checked against.
 */

/** The limits of §4.6. */
export const ROUTINE_LIMITS = {
  /** Source of one routine, in bytes. */
  sourceBytes: 65536,
  /** One run's default and longest duration, in seconds. */
  runSeconds: 120,
  maxRunSeconds: 300,
  /** Calls of one SDK operation in a run. */
  callsPerOperation: 200,
  /** Model calls in one run. */
  modelCallsPerRun: 50,
  /** Model calls per workspace per day; an operator can change it. */
  modelCallsPerDay: 1000,
  /** Output tokens of one model call. */
  modelOutputTokens: 4096,
  /** Runs one routine may queue in an hour before it is held and paused. */
  runsPerHour: 200,
  /** Records one schedule tick may fan out to. */
  scheduleFanOut: 200,
  /** A run's default expiry, in hours after it starts. */
  expiryHours: 24,
  /** One tool or model result, in bytes. */
  resultBytes: 65536,
  /** Text read from one file, in bytes. */
  fileTextBytes: 1048576,
  /** Days stored results are kept after a run ends. */
  resultDays: 7,
  /** Shortest schedule interval, in minutes. */
  scheduleMinutes: 15,
  /** Depth of routines triggering each other. */
  chainDepth: 8,
  /** Records a dry-run preview runs the code on. */
  previewRecords: 5,
  /** Tools one manifest may list. */
  tools: 20,
  /** Attempts of one run before it fails for good. */
  attempts: 3,
} as const;

export const ROUTINE_STATUSES = ['draft', 'active', 'paused', 'needs_attention', 'archived'] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

/** How the code runs (§5.1), plus the two sandbox jobs that run no routine code. */
export const ROUTINE_RUN_MODES = ['run', 'test', 'dry', 'check', 'build'] as const;
export type RoutineRunMode = (typeof ROUTINE_RUN_MODES)[number];

export const ROUTINE_RUN_STATUSES = [
  'queued',
  'held',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'expired',
  'stopped',
  'diverged',
  'budget_exhausted',
  'erased',
  'discarded',
] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];
export const FINISHED_RUN_STATUSES: readonly RoutineRunStatus[] = ROUTINE_RUN_STATUSES.filter(
  (status) => !['queued', 'held', 'running'].includes(status),
);

/** The coded reasons a builder reports for a gap (§5.2). */
export const ROUTINE_GAP_CODES = [
  'no_source',
  'no_tool',
  'tool_not_connected',
  'member_account',
  'field_not_filterable',
  'needs_aggregate_trigger',
  'needs_previous_value',
  'needs_instant_answer',
  'needs_blocking',
  'needs_deletion_trigger',
  'needs_person_rank',
  'model_unavailable',
  'over_limit',
  'unclear',
] as const;
export type RoutineGapCode = (typeof ROUTINE_GAP_CODES)[number];

export const routineReportSchema = z.strictObject({
  verdict: z.enum(['full', 'partial', 'not_possible']),
  gaps: z
    .array(
      z.strictObject({
        /** The part of the description the gap concerns, quoted or paraphrased. */
        part: z.string().trim().min(1).max(500),
        reason: z.enum(ROUTINE_GAP_CODES),
        /** What would make it possible. */
        fix: z.string().trim().min(1).max(500),
      }),
    )
    .max(20)
    .default([]),
});
export type RoutineReport = z.infer<typeof routineReportSchema>;

const ident = z.string().min(1).max(100);
/** A record filter in the grammar of `POST /v1/objects/:object/query`, by field key. */
export type RoutineFilter = { and?: RoutineFilter[]; or?: RoutineFilter[]; not?: RoutineFilter } & {
  [key: string]: unknown;
};
const filter: z.ZodType<RoutineFilter> = z.record(z.string(), z.unknown()) as z.ZodType<RoutineFilter>;

const recordTrigger = z.strictObject({
  kind: z.literal('record'),
  /** The object, by API name or universal ID; stored by universal ID. */
  object: ident,
  on: z
    .array(z.enum(['created', 'updated', 'links']))
    .min(1)
    .max(3),
  /** Fields to watch, by key; any change fires the routine without a list. */
  fields: z.array(ident).max(50).optional(),
  oncePerRecord: z.boolean().optional(),
});
const scheduleTrigger = z.strictObject({
  kind: z.literal('schedule'),
  /** Five-field cron, read in the workspace's time zone. */
  cron: z.string().min(9).max(100),
  /** With an object, each record matching `filter` gets its own run. */
  object: ident.optional(),
  filter: filter.optional(),
  oncePerRecord: z.boolean().optional(),
});
const manualTrigger = z.strictObject({
  kind: z.literal('manual'),
  object: ident,
  /** The button's label on the record. */
  label: z.string().trim().min(1).max(60).optional(),
  oncePerRecord: z.boolean().optional(),
});

export const routineManifestSchema = z.strictObject({
  when: z.discriminatedUnion('kind', [recordTrigger, scheduleTrigger, manualTrigger]),
  if: filter.optional(),
  /** A date field of the triggering record whose value ends the run early (§4.2). */
  expiry: z.strictObject({ field: ident }).optional(),
  uses: z.strictObject({
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(ROUTINE_LIMITS.tools),
    model: z.boolean(),
  }),
  /** The only rank in the first version (§6.4); room for a person's rank later. */
  rank: z.literal('agent').optional(),
});
export type RoutineManifest = z.infer<typeof routineManifestSchema>;
export type RoutineTrigger = RoutineManifest['when'];

/** A tool's contract, pinned by a version (§5.3): a change pauses the routine. */
export type ToolContract = {
  registrationId: string;
  effect: 'read' | 'write' | 'send';
  connection: 'workspace' | 'member';
  model: boolean;
};

/** A field as the routine SDK describes it. */
export type RoutineFieldDescription = {
  key: string;
  name: string;
  label: string;
  type: FieldType;
  description: string | null;
  filterable: boolean;
  nullable: boolean;
  /** For `select` and `multi_select`: the option values. */
  options?: string[];
  /** For `relation`: the target object's API name, and whether it holds many records. */
  target?: string;
  many?: boolean;
  /** Event core fields and relation inverses are read only through the SDK. */
  readOnly?: boolean;
};
export type RoutineObjectDescription = {
  name: string;
  universalId: string;
  label: string;
  description: string | null;
  isEvent: boolean;
  fields: RoutineFieldDescription[];
};
export type RoutineToolDescription = {
  name: string;
  title: string;
  description: string;
  effect: 'read' | 'write' | 'send';
  connection: 'workspace' | 'member';
  model: boolean;
  extension: string;
  /** `ready`, or why a standing routine cannot use it now. */
  status: 'ready' | 'not_connected' | 'unhealthy' | 'member_only' | 'conflict';
  inputSchema: JsonSchemaSubset;
  outputSchema: JsonSchemaSubset;
};
export type JsonSchemaSubset = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
  additionalProperties?: false;
  maxLength?: number;
  items?: JsonSchemaSubset;
  maxItems?: number;
};

/** `get_routine_capabilities`: what exists, as facts (§5.2). */
export type RoutineCapabilities = {
  objects: RoutineObjectDescription[];
  tools: RoutineToolDescription[];
  model: { available: boolean };
  timezone: string;
  triggers: ('record' | 'schedule' | 'manual')[];
  limits: typeof ROUTINE_LIMITS;
  gapCodes: readonly RoutineGapCode[];
  /** The SDK's declarations the code is type-checked against. */
  types: string;
  /** A hash of `types`: a version records the one it was checked against. */
  typesFingerprint: string;
};

/** A problem the checker or the type-check found, pointing at the part that failed. */
export type RoutineProblem = {
  part: 'manifest' | 'code';
  /** For the manifest, a dotted path; for the code, `line:column`. */
  at?: string;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// The runtime protocol between the routine runner and the API.

/** What the runner receives from the executor; IDs and credentials only. */
export const routineInvocationSchema = z.strictObject({
  kind: z.literal('routine'),
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  attempt: z.number().int().positive(),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  apiOrigin: z.url(),
  runToken: z.string().min(1).max(8192),
  deadline: z.iso.datetime(),
});
export type RoutineInvocation = z.infer<typeof routineInvocationSchema>;

/** `GET /v1/routines/runtime/run`: everything the runner needs for one run. */
export type RoutineRunContext = {
  run: {
    id: string;
    mode: RoutineRunMode;
    /** When the run counts as happening; code reads "now" from here. */
    at: string;
    timezone: string;
    dryRun: boolean;
    attempt: number;
  };
  trigger: { kind: 'record' | 'schedule' | 'manual' | 'test' | 'preview'; pressedBy?: string };
  /** Present for run, test and dry modes. */
  manifest?: RoutineManifest;
  code?: string;
  /** The SDK declarations for this workspace and the check to run. */
  types: string;
  typesFingerprint: string;
  /** Type-check before running: the workspace changed since the version was checked. */
  check: boolean;
  /** The triggering record, keyed by field keys, as it is when the run starts. */
  record?: RoutineRecord;
  /** Build mode: the person's description and the routine it is for. */
  build?: { description: string; routineId: string | null };
  model?: { origin: string };
};

/** A record as routine code sees it: values by field key. */
export type RoutineRecord = {
  id: string;
  object: string;
  createdAt: string;
  updatedAt: string;
  /** Event records: when it happened. */
  occurredAt?: string;
  /** Event records: the linked participant and `about` record IDs. */
  participants?: string[];
  about?: string[];
} & Record<string, unknown>;

export const ROUTINE_EFFECT_OPERATIONS = [
  'record.create',
  'record.update',
  'events.log',
  'remember',
  'tool',
  'ai.generate',
] as const;
export type RoutineEffectOperation = (typeof ROUTINE_EFFECT_OPERATIONS)[number];
export const ROUTINE_READ_OPERATIONS = [
  'record.get',
  'record.query',
  'record.aggregate',
  'files.text',
] as const;
export type RoutineReadOperation = (typeof ROUTINE_READ_OPERATIONS)[number];

/** `POST /v1/routines/runtime/effects`: one numbered effect. */
export const routineEffectRequestSchema = z.strictObject({
  position: z.number().int().min(1).max(100000),
  operation: z.enum(ROUTINE_EFFECT_OPERATIONS),
  args: z.record(z.string(), z.unknown()),
});
export type RoutineEffectRequest = z.infer<typeof routineEffectRequestSchema>;

/**
 * An effect's answer. `done` carries the result; `pending` a tool call to
 * poll, or a model call to make with `model`; `reported` means a dry or test
 * run recorded the call without making it, and `stop` that the run ends there.
 */
export type RoutineEffectResponse =
  | { state: 'done'; result: unknown; replayed: boolean; differs?: boolean }
  | { state: 'pending'; tool?: { callId: string } }
  | {
      state: 'model';
      model: {
        origin: string;
        token: string;
        name: string;
        maxTokens: number;
      };
    }
  | { state: 'reported'; stop: boolean };

/** Codes an effect is refused with; each ends the run with that status or error. */
export const ROUTINE_STOP_CODES = {
  routine_paused: 'stopped',
  run_expired: 'expired',
  run_diverged: 'diverged',
  budget_exhausted: 'budget_exhausted',
  run_erased: 'erased',
} as const satisfies Record<string, RoutineRunStatus>;

// ---------------------------------------------------------------------------
// Retainer's facts: fixed text generated from a manifest (§5.2, item 4).

export type FactsNames = {
  object: (universalId: string) => { singular: string; plural: string; isEvent: boolean };
  field: (objectUniversalId: string, key: string) => string;
  tool: (name: string) => { title: string; effect: 'read' | 'write' | 'send' } | undefined;
};

/** Plain sentences describing a manifest, generated by fixed code, never by a model. */
export function routineFacts(manifest: RoutineManifest, names: FactsNames): string[] {
  const facts: string[] = [];
  const when = manifest.when;
  const list = (items: string[]) =>
    items.length <= 1
      ? (items[0] ?? '')
      : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
  if (when.kind === 'record') {
    const object = names.object(when.object);
    const events = when.on.map((on) =>
      on === 'created'
        ? `a ${object.singular} is ${object.isEvent ? 'logged' : 'created'}`
        : on === 'updated'
          ? when.fields?.length
            ? `a ${object.singular}'s ${list(when.fields.map((key) => names.field(when.object, key)))} changes`
            : `a ${object.singular} changes in any way`
          : `a ${object.singular}'s participants or linked records change`,
    );
    facts.push(`Runs when ${list(events)}.`);
  } else if (when.kind === 'schedule') {
    const object = when.object ? names.object(when.object) : undefined;
    facts.push(
      object
        ? `Runs on the schedule "${when.cron}" (the workspace's time zone), once for each ${object.singular}${when.filter ? ' matching its filter' : ''}, up to ${ROUTINE_LIMITS.scheduleFanOut}.`
        : `Runs on the schedule "${when.cron}" (the workspace's time zone).`,
    );
  } else {
    const object = names.object(when.object);
    facts.push(
      `Runs when a person presses "${when.label ?? 'Run'}" on a ${object.singular}. Only then can it use that person's own connected accounts.`,
    );
  }
  if (manifest.if)
    facts.push(
      `Only when the ${names.object((when as { object: string }).object).singular} matches: ${describeFilter(manifest.if, (key) => names.field((when as { object: string }).object, key))}.`,
    );
  if (when.oncePerRecord) {
    const object = 'object' in when && when.object ? names.object(when.object) : undefined;
    facts.push(`Acts at most once for each ${object?.singular ?? 'record'}, ever.`);
  }
  if (manifest.expiry && 'object' in when && when.object)
    facts.push(
      `A run stops acting once the ${names.object(when.object).singular}'s ${names.field(when.object, manifest.expiry.field)} has passed, and 24 hours after it starts at the latest.`,
    );
  else facts.push('A run stops acting 24 hours after it starts.');
  if (manifest.uses.model)
    facts.push(
      'Calls a model, so the record content its code passes is sent to the model provider.',
    );
  else facts.push('Calls no model.');
  if (manifest.uses.tools.length) {
    const tools = manifest.uses.tools.map((name) => {
      const tool = names.tool(name);
      const effect =
        tool?.effect === 'send'
          ? 'acts outside Retainer'
          : tool?.effect === 'write'
            ? 'changes Retainer records'
            : 'answers a question';
      return `"${tool?.title ?? name}" (${effect})`;
    });
    facts.push(`May call these tools: ${tools.join(', ')}.`);
    if (manifest.uses.tools.some((name) => names.tool(name)?.effect === 'send'))
      facts.push('It can send things outside Retainer without anyone reviewing them first.');
  } else facts.push('Calls no tools and sends nothing.');
  facts.push(
    'Writes as an agent: its values never replace what a person or a sync set without review.',
  );
  return facts;
}

/** A filter in words: `stage is proposal and amount is greater than 100`. */
export function describeFilter(value: RoutineFilter, field: (key: string) => string): string {
  const words: Record<string, string> = {
    eq: 'is',
    neq: 'is not',
    in: 'is one of',
    contains: 'contains',
    gt: 'is greater than',
    gte: 'is at least',
    lt: 'is less than',
    lte: 'is at most',
  };
  const parts: string[] = [];
  for (const [key, condition] of Object.entries(value)) {
    if (key === 'and' && Array.isArray(condition))
      parts.push(condition.map((c) => describeFilter(c as RoutineFilter, field)).join(' and '));
    else if (key === 'or' && Array.isArray(condition))
      parts.push(
        `(${condition.map((c) => describeFilter(c as RoutineFilter, field)).join(' or ')})`,
      );
    else if (key === 'not' && condition && typeof condition === 'object')
      parts.push(`not (${describeFilter(condition as RoutineFilter, field)})`);
    else if (condition && typeof condition === 'object' && !Array.isArray(condition))
      for (const [op, operand] of Object.entries(condition)) {
        if (op === 'isNull')
          parts.push(`${field(key)} ${operand ? 'is empty' : 'is not empty'}`);
        else parts.push(`${field(key)} ${words[op] ?? op} ${JSON.stringify(operand)}`);
      }
    else parts.push(`${field(key)} is ${JSON.stringify(condition)}`);
  }
  return parts.join(' and ');
}

// ---------------------------------------------------------------------------
// The SDK's types, generated from the workspace (§4.4).

const RESERVED_SDK_NAMES = new Set(['files', 'events', 'tools', 'ai', 'remember']);

const tsString = (value: string) => JSON.stringify(value);
const comment = (text: string | null | undefined, indent = '') =>
  text ? `${indent}/** ${text.replaceAll('*/', '* /').replaceAll('\n', ' ')} */\n` : '';
const propertyKey = (key: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : tsString(key));

function valueType(field: RoutineFieldDescription): string {
  switch (field.type) {
    case 'text':
    case 'date':
    case 'date_time':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'select':
      return field.options?.length ? field.options.map(tsString).join(' | ') : 'string';
    case 'multi_select':
      return `(${field.options?.length ? field.options.map(tsString).join(' | ') : 'string'})[]`;
    case 'money':
      return 'Money';
    case 'emails':
      return 'Emails';
    case 'phones':
      return 'Phones';
    case 'links':
      return 'Links';
    case 'full_name':
      return 'FullName';
    case 'address':
      return 'Address';
    case 'relation':
      return field.many ? 'RecordId[]' : 'RecordId';
    case 'files':
      return 'FileId[]';
    default:
      return 'unknown';
  }
}

function schemaType(schema: JsonSchemaSubset, depth = 0): string {
  if (depth > 20) return 'unknown';
  switch (schema.type) {
    case 'null':
      return 'null';
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `${schema.items ? `(${schemaType(schema.items, depth + 1)})` : 'unknown'}[]`;
    case 'object': {
      const required = new Set(schema.required ?? []);
      const props = Object.entries(schema.properties ?? {}).map(
        ([key, child]) =>
          `${comment(child.description)}${propertyKey(key)}${required.has(key) ? '' : '?'}: ${schemaType(child, depth + 1)};`,
      );
      return `{ ${props.join(' ')} }`;
    }
  }
}

const BASE_TYPES = `
/** A record's ID. */
type RecordId = string;
/** A file's ID; read its text with retainer.files.text(id). */
type FileId = string;
type Money = { amountMicros: number; currency: string };
type Emails = { primary: string | null; additional?: string[] };
type Phones = { primary: { number: string; countryCode?: string } | null; additional?: { number: string; countryCode?: string }[] };
type Links = { primary: { url: string; label?: string } | null; additional?: { url: string; label?: string }[] };
type FullName = { first?: string; last?: string };
type Address = { street1?: string; street2?: string; city?: string; state?: string; postcode?: string; country?: string };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** A JSON Schema for a model's answer: object, array, string, number, integer, boolean, null. */
type OutputSchema =
  | { type: 'string' | 'number' | 'integer' | 'boolean' | 'null'; description?: string; enum?: readonly (string | number)[] }
  | { type: 'array'; items: OutputSchema; description?: string; maxItems?: number }
  | { type: 'object'; properties: { readonly [key: string]: OutputSchema }; required?: readonly string[]; description?: string };
type Infer<S> = S extends { type: 'object'; properties: infer P; required: readonly (infer R)[] }
  ? { [K in keyof P & R & string]: Infer<P[K]> } & { [K in Exclude<keyof P, R>]?: Infer<P[K]> }
  : S extends { type: 'object'; properties: infer P }
    ? { [K in keyof P]?: Infer<P[K]> }
    : S extends { type: 'array'; items: infer I }
      ? Infer<I>[]
      : S extends { enum: readonly (infer E)[] }
        ? E
        : S extends { type: 'string' }
          ? string
          : S extends { type: 'number' | 'integer' }
            ? number
            : S extends { type: 'boolean' }
              ? boolean
              : S extends { type: 'null' }
                ? null
                : unknown;
type Operators<V> = { eq?: V; neq?: V; in?: V[]; contains?: V extends (infer E)[] ? E : string; gt?: V; gte?: V; lt?: V; lte?: V; isNull?: boolean };
type Filter<F> = { [K in keyof F]?: Operators<NonNullable<F[K]>> } & { and?: Filter<F>[]; or?: Filter<F>[]; not?: Filter<F> };
type Sort<F> = { field: (keyof F & string) | 'createdAt' | 'updatedAt'; direction?: 'asc' | 'desc' }[];
type Page<R> = { records: R[]; count: number; nextCursor: string | null };
type AggregateOp = 'count' | 'count_empty' | 'count_not_empty' | 'count_unique' | 'percent_empty' | 'percent_not_empty' | 'sum' | 'avg' | 'min' | 'max';
type AggregateResult = { total: number; values: { field: string; op: AggregateOp; value: number | string | Money | null }[] };
type BaseRecord = { id: RecordId; createdAt: string; updatedAt: string };
type EventRecord = BaseRecord & { occurredAt: string; participants: RecordId[]; about: RecordId[] };
type WriteResult = { id: RecordId; fields: Record<string, 'applied' | 'pending_review' | 'superseded'> };
type ObjectClient<R, W> = {
  /** One record by ID, or null. */
  get(id: RecordId): Promise<R | null>;
  /** Records matching an exact filter, at most 100 a page. */
  query(input?: { filter?: Filter<W>; sort?: Sort<W>; limit?: number; cursor?: string }): Promise<Page<R>>;
  /** Counts, sums and other aggregates over matching records. */
  aggregate(input: { filter?: Filter<W>; aggregates: { field: keyof W & string; op: AggregateOp }[] }): Promise<AggregateResult>;
};
type EntityClient<R, W> = ObjectClient<R, W> & {
  /** Creates a record. When the run was triggered by an event, the values cite it. */
  create(values: W & { source?: RecordId }): Promise<WriteResult>;
  /** Updates a record. A value a person or a sync set waits for review. */
  update(id: RecordId, values: Partial<W> & { source?: RecordId }): Promise<WriteResult>;
};
type EventClient<R, W> = ObjectClient<R, W> & {
  /** Updates an event's fields. */
  update(id: RecordId, values: Partial<W> & { source?: RecordId }): Promise<WriteResult>;
};
type LogEventInput = {
  type: string;
  channel: string;
  occurredAt: string;
  title?: string;
  summary?: string;
  externalId?: string;
  fields?: Record<string, JsonValue>;
  participants?: ({ email: string; role?: string } | { phone: string; role?: string } | { recordId: RecordId; role?: string })[];
  about?: RecordId[];
};
type RunInfo = {
  id: string;
  /** When the run counts as happening. Read "now" from here, never from the clock. */
  at: string;
  timezone: string;
  /** A dry run reports its writes and tool calls without making them. */
  dryRun: boolean;
};
type TriggerInfo = { kind: 'record' | 'schedule' | 'manual' | 'test' | 'preview'; pressedBy?: string };
`;

/** Generates the declarations routine code is type-checked against. */
export function generateRoutineTypes(input: {
  objects: RoutineObjectDescription[];
  tools: RoutineToolDescription[];
  model: boolean;
}): string {
  const objects = [...input.objects]
    .filter((object) => !RESERVED_SDK_NAMES.has(object.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [
    '// Generated by Retainer from this workspace. Do not edit.',
    BASE_TYPES,
  ];
  const typeName = (object: RoutineObjectDescription) =>
    object.name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join('') || 'Object';
  for (const object of objects) {
    const name = typeName(object);
    const fields = object.fields.filter((field) => field.type !== 'json' || true);
    const read = fields
      .map(
        (field) =>
          `${comment(`${field.label}${field.description ? `: ${field.description}` : ''}`, '  ')}  ${propertyKey(field.key)}: ${valueType(field)}${field.nullable || field.type === 'files' || field.type === 'relation' ? ' | null' : ''};`,
      )
      .join('\n');
    const write = fields
      .filter((field) => !field.readOnly)
      .map((field) => `  ${propertyKey(field.key)}?: ${valueType(field)} | null;`)
      .join('\n');
    out.push(
      `${comment(`${object.label}${object.description ? `: ${object.description}` : ''}`)}type ${name}Record = ${object.isEvent ? 'EventRecord' : 'BaseRecord'} & {\n${read}\n};`,
    );
    out.push(`type ${name}Values = {\n${write}\n};`);
  }
  out.push(
    `type RoutineRecords = {\n${objects.map((object) => `  ${tsString(object.name)}: ${typeName(object)}Record;`).join('\n')}\n};`,
  );
  const tools = input.tools.filter((tool) => tool.status !== 'conflict');
  out.push(
    `type RoutineTools = {\n${tools
      .map(
        (tool) =>
          `${comment(`${tool.title}: ${tool.description} (${tool.effect}, from ${tool.extension})`, '  ')}  ${propertyKey(tool.name)}(input: ${schemaType(tool.inputSchema)}): Promise<${schemaType(tool.outputSchema)}>;`,
      )
      .join('\n')}\n};`,
  );
  out.push(`type Retainer = {
${objects
  .map(
    (object) =>
      `${comment(object.label, '  ')}  ${propertyKey(object.name)}: ${object.isEvent ? 'EventClient' : 'EntityClient'}<${typeName(object)}Record, ${typeName(object)}Values>;`,
  )
  .join('\n')}
  files: {
    /** The text of a file attached to a record, up to 1 MiB. */
    text(id: FileId): Promise<string>;
  };
  events: {
    /** Logs an event. */
    log(input: LogEventInput): Promise<{ id: RecordId }>;
  };
  /** Stores a plain-language fact about a record, or about the workspace. */
  remember(input: { about: RecordId | 'workspace'; text: string; source?: RecordId; quote?: string }): Promise<{ id: string }>;
  /** Tools installed extensions publish. Only those the manifest lists can be called. */
  tools: RoutineTools;
  ai: {
    /**${input.model ? '' : ' No model is available on this server.'} Asks a model for one typed answer. The model has no tools and sees only what you pass. */
    generate<const S extends OutputSchema>(input: { instructions: string; input: JsonValue; output: S }): Promise<Infer<S>>;
  };
};
/** What main receives. */
type RoutineContext<O extends keyof RoutineRecords | undefined = undefined> = {
  retainer: Retainer;
  record: O extends keyof RoutineRecords ? RoutineRecords[O] : undefined;
  run: RunInfo;
  trigger: TriggerInfo;
};`);
  return `${out.join('\n')}\n`;
}

/**
 * The routine runner's identity in the executable registry: a first-party
 * bundle, not an extension (§3.3). Its entry in RETAINER_EXTENSION_EXECUTABLES
 * names this registration and function.
 */
export const ROUTINE_RUNNER_REGISTRATION_ID = '6f1d7c52-9a3e-4b8f-a2d4-1c0e5b7f9a31';
export const ROUTINE_RUNNER_FUNCTION_ID = 'b3e0a9d4-27c6-4f15-8e2b-9d4c1a6f0e72';
