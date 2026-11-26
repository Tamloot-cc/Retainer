import type {
  Document,
  HttpMethods,
  OpenAPIV3_2,
  OperationObject,
  ParameterObject,
  ResponseObject,
} from 'fumadocs-openapi';

type Schema = OpenAPIV3_2.SchemaObject | OpenAPIV3_2.ReferenceObject;

const text = { type: 'string' } as const;
const id = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const integer = { type: 'integer' } as const;
const boolean = { type: 'boolean' } as const;
const choice = (...values: string[]) => ({ type: 'string' as const, enum: values });
const array = (items: Schema, limits: { minItems?: number; maxItems?: number } = {}): Schema => ({
  type: 'array',
  items,
  ...limits,
});
const object = (properties: Record<string, Schema>, required = Object.keys(properties)) =>
  ({
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }) satisfies Schema;
const map = (additionalProperties: Schema | true = true) => ({
  type: 'object' as const,
  additionalProperties,
});
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const bound = (minimum: number, maximum: number, defaultValue?: number): Schema => ({
  type: 'integer',
  minimum,
  maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const stringLength = (minLength: number, maxLength: number) =>
  ({
    type: 'string',
    minLength,
    maxLength,
  }) satisfies Schema;
const nullString: Schema = { type: ['string', 'null'] };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const aggregateOperation = choice(
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'countUnique',
  'sum',
  'avg',
  'min',
  'max',
);
const paged = (name: string, item: Schema) =>
  object({ [name]: array(item), nextCursor: nullString });
const attachment = choice('participant', 'about', 'field');
const bindings = ref('Bindings');
const recordFields: Schema = {
  type: 'object',
  additionalProperties: true,
  description: 'Keys are API field names from the workspace schema. Null clears a value.',
};
const sortBy = (field: Schema) =>
  array(object({ field, direction: choice('asc', 'desc') }, ['field']), { maxItems: 3 });
const sort = sortBy(text);
const eventQueryColumn = choice(
  'occurredAt',
  'channel',
  'externalId',
  'id',
  'createdAt',
  'updatedAt',
);
const queryFields = {
  search: stringLength(1, 500),
  filter: map(),
  sort,
  limit: bound(1, 200, 50),
  cursor: text,
  include: array(choice('relationReferences')),
  linked: object({ record: id, link: attachment }, ['record']),
};
const recordPage = (record: Schema) =>
  object(
    {
      records: array(record),
      nextCursor: nullString,
      relationReferences: map(ref('RecordReference')),
    },
    ['records', 'nextCursor'],
  );
const writeFields = { values: recordFields, source: id, bindings };
const upsertFields = {
  ...writeFields,
  id,
  match: {
    ...map(),
    minProperties: 1,
    maxProperties: 1,
    description: 'Match exactly one unique field.',
  },
  ifMissing: { ...choice('fail', 'create'), default: 'fail' },
  expectedUpdatedAt: timestamp,
} satisfies Record<string, Schema>;
const upsertTarget = { not: { required: ['id', 'match'] } };
const recordLinkFields = {
  participants: array(object({ handle: text, recordId: id, role: text }, []), { maxItems: 200 }),
  about: array(id, { maxItems: 200 }),
};
const viewFields = {
  name: text,
  kind: choice('table', 'board', 'calendar'),
  visibility: choice('private', 'workspace'),
  filter: { type: ['object', 'null'], additionalProperties: true } satisfies Schema,
  sort: nullable(sort),
  columns: nullable(
    object(
      {
        order: array(text, { maxItems: 200 }),
        widths: map(bound(40, 2000)),
        aggregates: map(aggregateOperation),
      },
      ['order'],
    ),
  ),
  position: { type: 'number' },
  groupBy: nullString,
  dateField: nullString,
  groupAggregate: nullable(object({ field: text, op: aggregateOperation })),
  hiddenGroups: nullable(array(nullString, { maxItems: 200 })),
} satisfies Record<string, Schema>;
const schemas: NonNullable<NonNullable<Document['components']>['schemas']> = {
  Workspace: object({ id, name: text, slug: text }),
  Actor: object(
    { id: text, type: choice('user', 'agent', 'integration', 'system'), name: text, via: text },
    ['id', 'type'],
  ),
  Session: object(
    {
      workspace: ref('Workspace'),
      actor: ref('Actor'),
      scopes: array(choice('read', 'write', 'schema:write', 'admin')),
      person: boolean,
      routinesAvailable: boolean,
      agentAvailable: boolean,
    },
    ['workspace', 'actor', 'scopes', 'person'],
  ),
  Error: object({
    error: object({ code: text, message: text, details: map() }, ['code', 'message']),
  }),
  Health: object(
    {
      status: choice('ok', 'error'),
      version: text,
      database: choice('ok', 'unreachable'),
      restrictedServingProtocol: integer,
    },
    ['status', 'version', 'database'],
  ),
  Bindings: object({
    bindings_revision: { type: 'integer', minimum: 1 },
    objectId: id,
    fieldIds: map(id),
  }),
  Record: object(
    {
      id,
      object: text,
      label: nullString,
      fields: recordFields,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: ref('Actor'),
      updatedBy: ref('Actor'),
      provenance: map(),
      relationReferences: map(ref('RecordReference')),
      counts: object({ comments: integer, facts: integer, linked: integer, claims: integer }),
      event: ref('EventDetails'),
    },
    ['id', 'object', 'label', 'fields', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
  ),
  RecordReference: object({ id, object: text, label: nullString }),
  RecordPage: recordPage(ref('Record')),
  WriteResult: object({
    id,
    created: boolean,
    fields: map(choice('applied', 'pending_review', 'superseded')),
    record: ref('Record'),
  }),
  RecordQuery: object(queryFields, []),
  EventQuery: object(
    {
      ...queryFields,
      filter: {
        ...map(),
        description:
          'Filter by a shared event column or by type. The type filter supports eq, neq, and in.',
      },
      sort: sortBy(eventQueryColumn),
    },
    [],
  ),
  EventPage: recordPage(ref('EventRecord')),
  EventRecord: {
    allOf: [ref('Record'), object({ type: text, event: ref('EventDetails') })],
  },
  Deleted: object({ id, deleted: { type: 'boolean', const: true } }),
  EventDetails: object({
    occurredAt: timestamp,
    channel: nullString,
    externalId: nullString,
    title: nullString,
    summary: nullString,
    participants: ref('Participants'),
    about: array(id),
  }),
  Participants: object({
    matched: array(object({ id, handle: nullString, role: nullString, recordId: id })),
    unmatched: array(
      object({ id, handle: nullString, role: nullString, reason: text, candidates: array(id) }, [
        'id',
        'handle',
        'role',
        'reason',
      ]),
    ),
  }),
  AddedLinks: object({ participants: ref('Participants'), about: array(id) }),
  LogEvent: object(
    {
      type: stringLength(1, 100),
      channel: stringLength(1, 100),
      externalId: stringLength(1, 500),
      occurredAt: timestamp,
      title: stringLength(0, 500),
      summary: stringLength(0, 20000),
      fields: recordFields,
      bindings,
      ...recordLinkFields,
    },
    ['type', 'channel', 'occurredAt'],
  ),
  LoggedEvent: object(
    {
      id,
      type: text,
      created: boolean,
      participants: ref('Participants'),
      about: array(id),
      added: ref('AddedLinks'),
    },
    ['id', 'type', 'created', 'participants', 'about'],
  ),
  SchemaDescription: object({
    workspace: {
      allOf: [
        ref('Workspace'),
        object({
          schemaVersion: integer,
          initialized: boolean,
          templates: array(object({ name: text, version: integer, appliedAt: timestamp })),
        }),
      ],
    },
    objects: array(
      object(
        {
          nameSingular: text,
          namePlural: text,
          labelSingular: text,
          labelPlural: text,
          description: nullString,
          labelField: nullString,
          class: choice('entity', 'event'),
          owner: text,
          isProtected: boolean,
          fields: array(map()),
          eventColumns: array(text),
        },
        [
          'nameSingular',
          'namePlural',
          'labelSingular',
          'labelPlural',
          'description',
          'labelField',
          'class',
          'owner',
          'isProtected',
          'fields',
        ],
      ),
    ),
    valueFormats: map(text),
    builtIns: array(map()),
  }),
  Fact: object(
    {
      id,
      record: id,
      profile: choice('workspace', 'me'),
      content: text,
      kind: choice('stated', 'inferred'),
      validFrom: timestamp,
      validTo: nullString,
      writtenBy: ref('Actor'),
      sources: array(
        object({ event: nullString, quote: nullString, internal: boolean }, ['event', 'quote']),
      ),
    },
    ['id', 'content', 'kind', 'validFrom', 'validTo', 'writtenBy', 'sources'],
  ),
  Comment: object({
    id,
    record: id,
    body: text,
    author: ref('Actor'),
    createdAt: timestamp,
    updatedAt: timestamp,
    editedAt: nullString,
  }),
  SavedView: object({
    id,
    object: text,
    name: text,
    kind: choice('table', 'board', 'calendar'),
    visibility: choice('private', 'workspace'),
    position: integer,
    filter: { type: ['object', 'null'], additionalProperties: true },
    sort: nullable(sort),
    columns: { type: ['object', 'null'], additionalProperties: true },
    groupBy: nullString,
    groupAggregate: nullable(object({ field: text, op: text })),
    hiddenGroups: array(nullString),
    dateField: nullString,
    createdBy: ref('Actor'),
    updatedBy: ref('Actor'),
    createdAt: timestamp,
    updatedAt: timestamp,
    issues: array(text),
  }),
  Assertion: object(
    {
      id,
      recordId: id,
      object: text,
      recordLabel: nullString,
      field: text,
      value: {},
      currentValue: {},
      status: choice('active', 'superseded', 'pending_review', 'rejected', 'retracted'),
      reason: nullString,
      actor: ref('Actor'),
      confidence: { type: 'number' },
      sourceRecordId: nullString,
      isInitial: boolean,
      observedAt: timestamp,
      createdAt: timestamp,
      source: nullable(object({ id, type: text, title: nullString, occurredAt: timestamp })),
      conflictingRecord: nullable(ref('RecordReference')),
      relationReferences: map(ref('RecordReference')),
      reviewedBy: nullable(ref('Actor')),
      reviewedAt: nullString,
    },
    [
      'id',
      'recordId',
      'object',
      'recordLabel',
      'field',
      'value',
      'currentValue',
      'status',
      'reason',
      'actor',
      'confidence',
      'sourceRecordId',
      'isInitial',
      'observedAt',
      'createdAt',
      'source',
      'conflictingRecord',
      'reviewedBy',
      'reviewedAt',
    ],
  ),
  FileMetadata: object(
    {
      name: text,
      mediaType: text,
      bytes: integer,
      sha256: text,
    },
    ['name', 'mediaType', 'bytes', 'sha256'],
  ),
  FileTransfer: object({ url: text, headers: map(text), expiresAt: timestamp }),
};

const paths: NonNullable<Document['paths']> = {};
const hostedServer = 'https://retainer.tamloot.cc';
const localServer = 'http://localhost:8787';
const simpleId = 'd2c0648c-2994-4f16-bdf1-a0136be6037d';
const evidenceId = '0f3a026b-dd58-4cb2-a871-98a8edabec97';
const date = '2026-11-18T10:00:00Z';
const pageParams = (defaultLimit: number, max: number) => [
  query('limit', 'Maximum items in this page.', bound(1, max, defaultLimit)),
  query('cursor', 'The opaque nextCursor from the previous page.'),
];
function query(name: string, description: string, schema: Schema = text): ParameterObject {
  return { name, in: 'query', schema, description };
}
const idempotency: ParameterObject = {
  in: 'header',
  name: 'Idempotency-Key',
  schema: stringLength(1, 200),
  description: 'Reuse the same key with the same request to retry.',
};

type Access = 'public' | 'any' | 'read' | 'write' | 'schema:write' | 'admin';
type Endpoint = {
  tag: string;
  method: HttpMethods;
  path: string;
  operationId: string;
  summary: string;
  access: Access;
  description?: string;
  parameters?: ParameterObject[];
  request?: { schema: Schema; example?: unknown; optional?: true };
  response: { schema?: Schema; example?: unknown; status?: number; description?: string };
  additionalResponses?: Record<string, ResponseObject>;
};

const json = (schema: Schema, example?: unknown) => ({
  'application/json': { schema, ...(example !== undefined ? { example } : {}) },
});
const response = (description: string, schema?: Schema, example?: unknown): ResponseObject => ({
  description,
  ...(schema ? { content: json(schema, example) } : {}),
});

function endpoint({
  method,
  path,
  operationId,
  summary,
  tag,
  access,
  description,
  parameters = [],
  request,
  response: success,
  additionalResponses,
}: Endpoint) {
  paths[path] ??= {};
  const pathParameters: ParameterObject[] = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    in: 'path',
    name,
    required: true,
    description:
      name === 'object'
        ? 'Object API name.'
        : name === 'name'
          ? 'Template API name.'
          : 'Retainer identifier.',
    example: name === 'object' ? 'company' : name === 'name' ? 'starter' : simpleId,
    schema:
      name === 'object' ||
      name === 'name' ||
      (name === 'id' && /\/(facts|context|timeline)$/.test(path) && path.startsWith('/v1/records/'))
        ? text
        : id,
  }));
  const accessText =
    access === 'public'
      ? ''
      : access === 'any'
        ? 'Requires a workspace API key.'
        : `Requires the \`${access}\` scope.`;
  const operation: OperationObject = {
    tags: [tag],
    operationId,
    summary,
    description: [description, accessText].filter(Boolean).join(' '),
    ...(access === 'public' ? { security: [] } : {}),
    parameters: [...pathParameters, ...parameters],
    ...(request
      ? {
          requestBody: {
            required: !request.optional,
            content: json(request.schema, request.example),
          },
        }
      : {}),
    responses: {
      [success.status ?? 200]: response(
        success.description ?? 'Successful response.',
        success.schema,
        success.example,
      ),
      ...(access === 'public' ? {} : { '401': { $ref: '#/components/responses/Unauthorized' } }),
      ...additionalResponses,
      ...(access === 'public' ? {} : { default: { $ref: '#/components/responses/ApiError' } }),
    },
  };
  paths[path][method] = operation;
}

endpoint({
  tag: 'Workspace',
  method: 'get',
  path: '/health',
  operationId: 'health',
  summary: 'Check server health',
  access: 'public',
  description: 'Check the server version and database connectivity.',
  response: { schema: ref('Health'), example: { status: 'ok', version: '0.1.0', database: 'ok' } },
  additionalResponses: {
    '503': response('The database is unreachable.', ref('Health'), {
      status: 'error',
      version: '0.1.0',
      database: 'unreachable',
    }),
  },
});
endpoint({
  tag: 'Workspace',
  method: 'get',
  path: '/v1/me',
  operationId: 'get-caller',
  summary: 'Verify the caller and workspace',
  access: 'any',
  description:
    'Read the workspace, actor, scopes, and capabilities associated with this credential.',
  response: {
    schema: ref('Session'),
    example: {
      workspace: { id: simpleId, name: 'Acme', slug: 'acme' },
      actor: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
      scopes: ['read', 'write'],
      person: false,
    },
  },
});
endpoint({
  tag: 'Schema',
  method: 'get',
  path: '/v1/schema',
  operationId: 'get-schema',
  summary: 'Read the workspace schema',
  access: 'read',
  description: 'Find object and field API names, value formats, and built-in memory tools.',
  response: { schema: ref('SchemaDescription') },
});

endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/objects/{object}/records',
  operationId: 'create-record',
  summary: 'Create a record',
  access: 'write',
  parameters: [idempotency],
  request: { schema: object(writeFields, ['values']), example: { values: { name: 'Acme' } } },
  response: { status: 201, schema: ref('WriteResult') },
});
endpoint({
  tag: 'Records',
  method: 'get',
  path: '/v1/records/{id}',
  operationId: 'get-record',
  summary: 'Read a record',
  access: 'read',
  parameters: [query('include', 'Comma-separated provenance, relationReferences, or counts.')],
  response: {
    schema: ref('Record'),
    example: {
      id: simpleId,
      object: 'company',
      label: 'Acme',
      fields: { name: 'Acme' },
      createdAt: date,
      updatedAt: date,
      createdBy: { type: 'agent', id: 'inbox' },
      updatedBy: { type: 'agent', id: 'inbox' },
    },
  },
});
endpoint({
  tag: 'Records',
  method: 'patch',
  path: '/v1/records/{id}',
  operationId: 'update-record',
  summary: 'Update a record',
  access: 'write',
  description:
    'Set fields by API name. Supply expectedUpdatedAt to reject changes if the record has changed.',
  request: {
    schema: object({ ...writeFields, expectedUpdatedAt: timestamp }, ['values']),
    example: { values: { name: 'Acme Ltd' }, source: evidenceId },
  },
  response: { schema: ref('WriteResult') },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/objects/{object}/query',
  operationId: 'query-records',
  summary: 'Query records',
  access: 'read',
  description: 'Filter, sort, and page the records of a single object by workspace field names.',
  request: { schema: ref('RecordQuery'), example: { filter: { name: 'Acme' }, limit: 10 } },
  response: { schema: ref('RecordPage'), example: { records: [], nextCursor: null } },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/objects/{object}/upsert',
  operationId: 'upsert-record',
  summary: 'Update or create a matching record',
  access: 'write',
  description:
    'Identify the record by ID or one unique field. Set ifMissing to create to add a record when there is no match.',
  request: {
    schema: { ...object(upsertFields, []), ...upsertTarget },
    example: { id: simpleId, values: { name: 'Acme Ltd' }, ifMissing: 'fail' },
  },
  response: { schema: ref('WriteResult'), description: 'An existing record was found.' },
  additionalResponses: { '201': response('A record was created.', ref('WriteResult')) },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/records/upsert',
  operationId: 'upsert-records',
  summary: 'Write multiple records',
  access: 'write',
  description: 'Process records in order. Each item returns its own result or error.',
  request: {
    schema: object({
      items: array(
        {
          ...object(
            {
              ...upsertFields,
              object: text,
              idempotencyKey: {
                ...stringLength(1, 200),
                description: 'For creates that supply neither id nor match.',
              },
            },
            ['object'],
          ),
          ...upsertTarget,
        },
        { minItems: 1, maxItems: 50 },
      ),
    }),
  },
  response: { schema: object({ results: array({ anyOf: [ref('WriteResult'), ref('Error')] }) }) },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/objects/{object}/aggregate',
  operationId: 'aggregate-records',
  summary: 'Aggregate matching records',
  access: 'read',
  request: {
    schema: object(
      {
        search: queryFields.search,
        filter: queryFields.filter,
        groupBy: text,
        aggregates: array(
          object({
            field: text,
            op: aggregateOperation,
          }),
          { maxItems: 50 },
        ),
      },
      [],
    ),
    example: { aggregates: [{ field: 'amount', op: 'sum' }] },
  },
  response: {
    schema: object({ total: integer, values: array(map()), groups: array(map()) }, [
      'total',
      'values',
    ]),
  },
});

endpoint({
  tag: 'Events',
  method: 'post',
  path: '/v1/events',
  operationId: 'log-event',
  summary: 'Log an event',
  access: 'write',
  description:
    'Log a conversation using an event type from your workspace. Reusing a channel and externalId returns the existing event and adds any new links.',
  request: {
    schema: ref('LogEvent'),
    example: {
      type: 'conversation',
      channel: 'calendar',
      externalId: 'acme-renewal',
      occurredAt: date,
      title: 'Acme renewal review',
      fields: { medium: 'meeting' },
      about: [simpleId],
    },
  },
  response: { status: 201, schema: ref('LoggedEvent'), description: 'A new event was logged.' },
  additionalResponses: {
    '200': response('The event was already logged.', ref('LoggedEvent')),
    '409': response('The identity belongs to a conflicting or retracted event.', ref('Error')),
  },
});
endpoint({
  tag: 'Events',
  method: 'post',
  path: '/v1/events/query',
  operationId: 'query-events',
  summary: 'Query across event types',
  access: 'read',
  description: 'Filter by shared event columns or event type, and page the results.',
  request: { schema: ref('EventQuery'), example: { filter: { type: 'conversation' }, limit: 10 } },
  response: { schema: ref('EventPage') },
});
endpoint({
  tag: 'Events',
  method: 'get',
  path: '/v1/events/{id}',
  operationId: 'get-event',
  summary: 'Read an event',
  access: 'read',
  response: { schema: ref('Record') },
});
endpoint({
  tag: 'Events',
  method: 'post',
  path: '/v1/events/{id}/links',
  operationId: 'link-event',
  summary: 'Link an event to records',
  access: 'write',
  description: 'Add participants or records the event is about. Existing links are preserved.',
  request: {
    schema: {
      ...object({ ...recordLinkFields, bindings }, []),
      anyOf: [
        { required: ['participants'], properties: { participants: { minItems: 1 } } },
        { required: ['about'], properties: { about: { minItems: 1 } } },
      ],
    },
    example: { about: [simpleId] },
  },
  response: { schema: { allOf: [ref('Record'), object({ added: ref('AddedLinks') })] } },
});
endpoint({
  tag: 'Facts',
  method: 'post',
  path: '/v1/records/{id}/facts',
  operationId: 'remember-fact',
  summary: 'Remember a fact',
  access: 'write',
  description:
    'Cite the event a fact came from when it is available. The ID can also be workspace or me for a memory profile.',
  parameters: [idempotency],
  request: {
    schema: object(
      { text: stringLength(1, 5000), source: id, quote: stringLength(1, 5000), supersedes: id },
      ['text'],
    ),
    example: { text: 'Acme needs legal review before renewal.', source: evidenceId },
  },
  response: { status: 201, schema: object({ fact: ref('Fact') }) },
});
endpoint({
  tag: 'Facts',
  method: 'get',
  path: '/v1/records/{id}/facts',
  operationId: 'list-facts',
  summary: 'List facts',
  access: 'read',
  description: 'List facts about a record, the workspace profile, or the personal profile.',
  parameters: pageParams(100, 500),
  response: {
    schema: object(
      {
        record: id,
        profile: choice('workspace', 'me'),
        facts: array(ref('Fact')),
        nextCursor: nullString,
      },
      ['facts', 'nextCursor'],
    ),
  },
});
endpoint({
  tag: 'Facts',
  method: 'delete',
  path: '/v1/facts/{id}',
  operationId: 'retract-fact',
  summary: 'Retract a fact',
  access: 'read',
  description:
    'Shared facts also require write. A signed-in person may retract their own personal fact.',
  response: { schema: ref('Deleted') },
});
endpoint({
  tag: 'Retrieval',
  method: 'post',
  path: '/v1/search',
  operationId: 'search',
  summary: 'Search records, facts, and events',
  access: 'read',
  description: 'Search workspace text. The limit applies separately to each result category.',
  request: {
    schema: object(
      { query: stringLength(1, 500), limit: bound(1, 50, 10), includeContext: boolean },
      ['query'],
    ),
    example: { query: 'Acme renewal', limit: 10 },
  },
  response: {
    schema: object(
      {
        records: array(
          object(
            {
              id,
              object: text,
              label: nullString,
              match: choice('text', 'similar_label'),
              detail: text,
            },
            ['id', 'object', 'label', 'match'],
          ),
        ),
        facts: array(
          object(
            {
              id,
              record: id,
              profile: choice('workspace', 'me'),
              content: text,
              validFrom: timestamp,
            },
            ['id', 'content', 'validFrom'],
          ),
        ),
        events: array(
          object(
            {
              id,
              type: text,
              occurredAt: timestamp,
              title: nullString,
              summary: nullString,
              records: array(id),
              match: choice('content'),
            },
            ['id', 'type', 'occurredAt', 'title', 'summary', 'records'],
          ),
        ),
        references: map(ref('RecordReference')),
      },
      ['records', 'facts', 'events'],
    ),
    example: { records: [], facts: [], events: [] },
  },
});

const schemaStatus = choice('applied', 'proposed', 'rejected', 'failed');
const schemaChange = object(
  {
    id,
    status: schemaStatus,
    operations: array(map()),
    request: array(map()),
    isDestructive: boolean,
    template: text,
    reason: nullString,
    requestedBy: ref('Actor'),
    decidedBy: nullable(ref('Actor')),
    appliedVersion: { type: ['integer', 'null'] },
    error: nullString,
    createdAt: timestamp,
    decidedAt: nullString,
  },
  [
    'id',
    'status',
    'operations',
    'request',
    'isDestructive',
    'reason',
    'requestedBy',
    'decidedBy',
    'appliedVersion',
    'error',
    'createdAt',
    'decidedAt',
  ],
);
const schemaResult = object(
  {
    status: choice('applied', 'proposed', 'rejected', 'failed', 'unchanged'),
    change: nullable(schemaChange),
    schemaVersion: integer,
    recordIds: array(id),
  },
  ['status', 'change', 'schemaVersion'],
);
endpoint({
  tag: 'Schema',
  method: 'post',
  path: '/v1/schema/changes',
  operationId: 'request-schema-change',
  summary: 'Request a schema change',
  access: 'schema:write',
  description:
    'Submit schema operations. Changes that need review are proposed for a workspace administrator.',
  request: {
    schema: object(
      {
        operations: array(object({ op: text }, ['op']), { minItems: 1, maxItems: 100 }),
        reason: stringLength(0, 2000),
      },
      ['operations'],
    ),
  },
  response: {
    schema: schemaResult,
    description: 'The schema change was applied or made no changes.',
  },
  additionalResponses: {
    '202': response('The proposal is pending review.', schemaResult),
    '409': response('The change failed to apply.', schemaResult),
  },
});
endpoint({
  tag: 'Schema',
  method: 'get',
  path: '/v1/schema/changes',
  operationId: 'list-schema-changes',
  summary: 'List schema changes',
  access: 'read',
  parameters: [...pageParams(50, 200), query('status', 'Filter by change status.', schemaStatus)],
  response: {
    schema: object({ changes: array(schemaChange), total: integer, nextCursor: nullString }),
  },
});
endpoint({
  tag: 'Schema',
  method: 'get',
  path: '/v1/schema/changes/{id}',
  operationId: 'get-schema-change',
  summary: 'Read a schema change',
  access: 'read',
  response: { schema: schemaChange },
});
for (const decision of ['approve', 'reject'] as const) {
  endpoint({
    tag: 'Schema',
    method: 'post',
    path: `/v1/schema/changes/{id}/${decision}`,
    operationId: `${decision}-schema-change`,
    summary: decision === 'approve' ? 'Approve a schema change' : 'Reject a schema change',
    access: 'admin',
    description: 'The caller must act as a user.',
    response: { schema: schemaResult },
    additionalResponses: { '409': response('The change failed to apply.', schemaResult) },
  });
}
endpoint({
  tag: 'Schema',
  method: 'get',
  path: '/v1/templates',
  operationId: 'list-templates',
  summary: 'List workspace templates',
  access: 'read',
  response: {
    schema: object({
      templates: array(
        object({
          name: text,
          version: integer,
          label: text,
          description: text,
          applied: boolean,
          adds: object({
            objects: array(object({ name: text, fields: array(text) })),
            fields: array(object({ object: text, field: text })),
          }),
        }),
      ),
    }),
  },
});
endpoint({
  tag: 'Schema',
  method: 'post',
  path: '/v1/templates/{name}/apply',
  operationId: 'apply-template',
  summary: 'Apply a workspace template',
  access: 'schema:write',
  response: { schema: schemaResult },
});

const impactedRecords = array(object({ object: text, count: integer }));
const eventRetraction = {
  retractedAssertions: integer,
  recomputedRecordIds: array(id),
  hiddenFactIds: array(id),
};
const optionalBindings = { schema: object({ bindings }, []), optional: true as const };
endpoint({
  tag: 'Records',
  method: 'get',
  path: '/v1/records/{id}/delete-impact',
  operationId: 'get-delete-impact',
  summary: 'Preview the impact of a record deletion',
  access: 'read',
  response: { schema: object({ id, records: impactedRecords }) },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/records/delete-impact',
  operationId: 'get-bulk-delete-impact',
  summary: 'Preview the impact of several record deletions',
  access: 'read',
  request: { schema: object({ ids: array(id, { minItems: 1, maxItems: 200 }) }) },
  response: { schema: object({ ids: array(id), records: impactedRecords }) },
});
endpoint({
  tag: 'Records',
  method: 'delete',
  path: '/v1/records/{id}',
  operationId: 'delete-record',
  summary: 'Soft-delete a record',
  access: 'write',
  description: 'For events, also retracts facts and field claims that depended on the event.',
  request: optionalBindings,
  response: {
    schema: object(
      { id, deleted: { const: true }, deletedRecordIds: array(id), ...eventRetraction },
      ['id', 'deleted'],
    ),
  },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/records/{id}/merge',
  operationId: 'merge-record',
  summary: 'Merge two records',
  access: 'write',
  description: 'The caller must act as a user. The ID in the URL identifies the survivor.',
  parameters: [idempotency],
  request: { schema: object({ recordId: id, values: recordFields, bindings }, ['recordId']) },
  response: {
    schema: object({
      id,
      mergedId: id,
      merged: boolean,
      recomputedRecordIds: array(id),
      record: ref('Record'),
    }),
  },
});
endpoint({
  tag: 'Records',
  method: 'post',
  path: '/v1/records/{id}/forget',
  operationId: 'forget-person',
  summary: 'Erase a person',
  access: 'admin',
  description: 'A user with admin scope can permanently erase a person for a privacy request.',
  response: {
    schema: object(
      {
        id,
        forgotten: { const: true },
        counts: map(integer),
        storage: object({ pending: integer, deletionIds: array(id) }),
        recomputedRecordIds: array(id),
        reviewCandidates: object({ records: array(id), facts: array(id), events: array(id) }),
      },
      ['id', 'forgotten', 'counts', 'recomputedRecordIds', 'reviewCandidates'],
    ),
  },
});

endpoint({
  tag: 'Events',
  method: 'get',
  path: '/v1/records/{id}/events',
  operationId: 'list-record-events',
  summary: 'List events linked to a record',
  access: 'read',
  parameters: [
    ...pageParams(50, 200),
    query('link', 'Filter by how the event is attached.', attachment),
  ],
  response: {
    schema: object({
      items: array({ allOf: [ref('Record'), object({ via: map(), event: ref('EventDetails') })] }),
      nextCursor: nullString,
      references: map(ref('RecordReference')),
    }),
  },
});
endpoint({
  tag: 'Events',
  method: 'post',
  path: '/v1/events/move',
  operationId: 'move-events',
  summary: 'Move events to a different type',
  access: 'schema:write',
  description:
    'Use dryRun to preview the change. Applying a move requires a user with admin scope.',
  request: {
    schema: object(
      {
        from: text,
        to: text,
        events: array(id, { minItems: 1, maxItems: 1000 }),
        fields: map(text),
        drop: array(text, { maxItems: 200 }),
        defaults: recordFields,
        dryRun: boolean,
      },
      ['from', 'to'],
    ),
    example: { from: 'meeting', to: 'conversation', defaults: { medium: 'meeting' }, dryRun: true },
  },
  response: {
    schema: object({
      id: nullString,
      dryRun: boolean,
      from: text,
      to: text,
      eventIds: array(id),
      fields: array(object({ from: text, to: text, events: integer })),
      dropped: array(object({ field: text, events: integer, assertions: integer })),
      defaults: array(object({ field: text, events: integer })),
    }),
  },
});
endpoint({
  tag: 'Events',
  method: 'delete',
  path: '/v1/events/{id}',
  operationId: 'delete-event',
  summary: 'Delete an event and retract its claims',
  access: 'write',
  request: optionalBindings,
  response: { schema: object({ id, deleted: { const: true }, ...eventRetraction }) },
});
for (const { suffix, operationId, summary } of [
  {
    suffix: 'participants/{participantId}',
    operationId: 'remove-event-participant',
    summary: 'Remove an event participant',
  },
  {
    suffix: 'about/{recordId}',
    operationId: 'remove-event-about',
    summary: 'Unlink a record from an event',
  },
]) {
  endpoint({
    tag: 'Events',
    method: 'delete',
    path: `/v1/events/{id}/${suffix}`,
    operationId,
    summary,
    access: 'write',
    description: 'The caller must act as a user.',
    response: { schema: ref('Record') },
  });
}
endpoint({
  tag: 'Events',
  method: 'get',
  path: '/v1/events/{id}/content',
  operationId: 'get-event-content',
  summary: 'Read full event content',
  access: 'read',
  parameters: [query('after', 'The opaque nextAfter from the previous page.')],
  response: {
    schema: object({
      parts: array(object({ id, occurredAt: timestamp, originalDate: nullString, text })),
      nextAfter: nullString,
    }),
  },
});
endpoint({
  tag: 'Events',
  method: 'get',
  path: '/v1/events/{id}/claims',
  operationId: 'get-event-claims',
  summary: 'Read assertions and facts that cite an event',
  access: 'read',
  parameters: [
    query('limit', 'Maximum items per collection.', bound(1, 200, 50)),
    query('assertionsCursor', 'Assertions page cursor.'),
    query('factsCursor', 'Facts page cursor.'),
    query('own', 'Set false to omit assertions on the event itself.', boolean),
  ],
  response: {
    schema: object({
      assertions: array(ref('Assertion')),
      facts: array(ref('Fact')),
      nextCursors: object({ assertions: nullString, facts: nullString }),
    }),
  },
});

endpoint({
  tag: 'Retrieval',
  method: 'get',
  path: '/v1/records/{id}/context',
  operationId: 'get-context',
  summary: 'Read a context pack',
  access: 'read',
  description:
    'Get selected fields, facts, and related information for a record or supported memory alias.',
  parameters: [
    query('tokenBudget', 'Approximate size budget for the context pack.', bound(1, 16000, 2000)),
  ],
  response: {
    schema: {
      anyOf: [
        object({
          record: object({
            id,
            object: text,
            label: nullString,
            fields: map(
              object({
                value: {},
                writtenBy: ref('Actor'),
                observedAt: timestamp,
              }),
            ),
          }),
          linkedRecords: array(map()),
          facts: array(map()),
          recentEvents: array(map()),
          omitted: object({ linkedRecords: integer, facts: integer, recentEvents: integer }),
          tokenEstimate: integer,
        }),
        object({
          profile: choice('workspace', 'me'),
          label: nullString,
          facts: array(map()),
          omitted: object({ facts: integer }),
          tokenEstimate: integer,
        }),
      ],
    },
  },
});
endpoint({
  tag: 'Retrieval',
  method: 'get',
  path: '/v1/records/{id}/timeline',
  operationId: 'get-timeline',
  summary: 'Read a record timeline',
  access: 'read',
  parameters: [
    ...pageParams(50, 200),
    query('types', 'Comma-separated timeline item types.'),
    query('fields', 'Comma-separated field API names.'),
    query('eventTypes', 'Comma-separated event type API names.'),
    query('from', 'Start of the time range.', timestamp),
    query('to', 'End of the time range.', timestamp),
  ],
  response: {
    schema: object(
      {
        record: id,
        profile: choice('workspace', 'me'),
        items: array(map()),
        nextCursor: nullString,
      },
      ['items', 'nextCursor'],
    ),
  },
});

endpoint({
  tag: 'Views',
  method: 'get',
  path: '/v1/objects/{object}/views',
  operationId: 'list-views',
  summary: 'List saved views',
  access: 'read',
  response: { schema: object({ views: array(ref('SavedView')) }) },
});
endpoint({
  tag: 'Views',
  method: 'post',
  path: '/v1/objects/{object}/views',
  operationId: 'create-view',
  summary: 'Create a saved view',
  access: 'write',
  request: {
    schema: object(viewFields, ['name', 'kind']),
    example: { name: 'Pipeline', kind: 'table', visibility: 'workspace' },
  },
  response: { status: 201, schema: ref('SavedView') },
});
endpoint({
  tag: 'Views',
  method: 'get',
  path: '/v1/views/{id}',
  operationId: 'get-view',
  summary: 'Read a saved view',
  access: 'read',
  response: { schema: ref('SavedView') },
});
endpoint({
  tag: 'Views',
  method: 'patch',
  path: '/v1/views/{id}',
  operationId: 'update-view',
  summary: 'Update a saved view',
  access: 'write',
  description: 'Only fields included in the request are changed.',
  request: { schema: object(viewFields, []), example: { name: 'Open deals' } },
  response: { schema: ref('SavedView') },
});
endpoint({
  tag: 'Views',
  method: 'delete',
  path: '/v1/views/{id}',
  operationId: 'delete-view',
  summary: 'Delete a saved view',
  access: 'write',
  response: { schema: ref('Deleted') },
});

endpoint({
  tag: 'Comments',
  method: 'get',
  path: '/v1/records/{id}/comments',
  operationId: 'list-comments',
  summary: 'List comments',
  access: 'read',
  parameters: pageParams(50, 200),
  response: {
    schema: object({
      record: id,
      items: array(ref('Comment')),
      total: integer,
      nextCursor: nullString,
    }),
  },
});
const commentBody = {
  schema: object({ body: stringLength(1, 10000) }),
  example: { body: 'Loop in legal before renewal.' },
};
endpoint({
  tag: 'Comments',
  method: 'post',
  path: '/v1/records/{id}/comments',
  operationId: 'create-comment',
  summary: 'Add a comment',
  access: 'write',
  description: 'The caller must act as a user.',
  parameters: [idempotency],
  request: commentBody,
  response: { status: 201, schema: ref('Comment') },
});
endpoint({
  tag: 'Comments',
  method: 'patch',
  path: '/v1/comments/{id}',
  operationId: 'update-comment',
  summary: 'Edit a comment',
  access: 'write',
  description: 'Only the original author can edit a comment.',
  parameters: [idempotency],
  request: commentBody,
  response: { schema: ref('Comment') },
});
endpoint({
  tag: 'Comments',
  method: 'delete',
  path: '/v1/comments/{id}',
  operationId: 'delete-comment',
  summary: 'Delete a comment',
  access: 'write',
  description: 'The author or a user with admin scope can delete it.',
  parameters: [idempotency],
  response: { schema: ref('Deleted') },
});

const collections = ['pendingAssertions', 'unresolvedParticipants', 'mergeSuggestions'];
endpoint({
  tag: 'Review',
  method: 'get',
  path: '/v1/review',
  operationId: 'get-review-queue',
  summary: 'Read the review queue',
  access: 'read',
  parameters: [
    query('limit', 'Maximum items per collection.', bound(1, 500, 100)),
    ...collections.map((name) => query(`${name}Cursor`, `Page cursor for ${name}.`)),
  ],
  response: {
    schema: object({
      pendingAssertions: array(ref('Assertion')),
      unresolvedParticipants: array(map()),
      mergeSuggestions: array(map()),
      totals: map(integer),
      nextCursors: map(nullString),
    }),
  },
});
endpoint({
  tag: 'Review',
  method: 'get',
  path: '/v1/records/{id}/assertions',
  operationId: 'list-assertions',
  summary: 'List field assertions for a record',
  access: 'read',
  parameters: [...pageParams(50, 200), query('field', 'Filter by field API name.')],
  response: { schema: paged('items', ref('Assertion')) },
});
endpoint({
  tag: 'Review',
  method: 'get',
  path: '/v1/assertions/{id}',
  operationId: 'get-assertion',
  summary: 'Read an assertion',
  access: 'read',
  response: { schema: ref('Assertion') },
});
for (const decision of ['accept', 'reject'] as const) {
  endpoint({
    tag: 'Review',
    method: 'post',
    path: `/v1/assertions/{id}/${decision}`,
    operationId: `${decision}-assertion`,
    summary:
      decision === 'accept' ? 'Accept a proposed field value' : 'Reject a proposed field value',
    access: 'write',
    description: 'The caller must act as a user.',
    response: {
      schema: object(
        {
          assertionId: id,
          status: choice('accepted', 'rejected'),
          fields: map(choice('applied', 'pending_review', 'superseded')),
          record: ref('Record'),
        },
        ['assertionId', 'status', 'record'],
      ),
    },
  });
}
endpoint({
  tag: 'Review',
  method: 'post',
  path: '/v1/review/merges/{id}/dismiss',
  operationId: 'dismiss-merge',
  summary: 'Dismiss a merge suggestion',
  access: 'write',
  description: 'The caller must act as a user.',
  response: { schema: object({ id, status: choice('dismissed') }) },
});

endpoint({
  tag: 'Files',
  method: 'post',
  path: '/v1/files/intents',
  operationId: 'create-file-intent',
  summary: 'Create a file upload intent',
  access: 'write',
  description:
    'Upload the bytes to the signed transfer URL, then finalize the file before referencing it.',
  parameters: [{ ...idempotency, required: true }],
  request: {
    schema: object(
      {
        name: text,
        mediaType: text,
        bytes: integer,
        sha256: text,
        sourceItemId: id,
      },
      ['name', 'mediaType', 'bytes', 'sha256'],
    ),
  },
  response: { status: 201, schema: object({ id, upload: ref('FileTransfer') }) },
});
endpoint({
  tag: 'Files',
  method: 'post',
  path: '/v1/files/{id}/finalize',
  operationId: 'finalize-file',
  summary: 'Finalize a file upload',
  access: 'write',
  response: { schema: { allOf: [ref('FileMetadata'), object({ id, state: choice('ready') })] } },
});
endpoint({
  tag: 'Files',
  method: 'get',
  path: '/v1/files/{id}',
  operationId: 'get-file',
  summary: 'Read file metadata',
  access: 'read',
  response: { schema: { allOf: [ref('FileMetadata'), object({ id })] } },
});
endpoint({
  tag: 'Files',
  method: 'post',
  path: '/v1/files/{id}/download',
  operationId: 'download-file',
  summary: 'Request a signed download',
  access: 'read',
  response: { schema: ref('FileTransfer') },
});
endpoint({
  tag: 'Files',
  method: 'post',
  path: '/v1/files/erasure-status',
  operationId: 'get-file-erasure-status',
  summary: 'Check file erasure jobs',
  access: 'admin',
  request: { schema: object({ ids: array(id, { minItems: 1, maxItems: 10000 }) }) },
  response: {
    schema: object({
      pending: integer,
      succeeded: integer,
      jobs: array(object({ id, status: text, code: nullString })),
    }),
  },
});

export const contract: Document = {
  openapi: '3.2.0',
  info: {
    title: 'Retainer REST API',
    version: 'v1',
    description:
      'The workspace REST API for Retainer. Object names and field shapes depend on the workspace schema.',
  },
  servers: [
    { url: hostedServer, description: 'Hosted Retainer' },
    { url: localServer, description: 'Local Docker Compose' },
  ],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'A workspace API key.' },
    },
    schemas,
    responses: {
      Unauthorized: response(
        'The workspace API key is missing, invalid, or revoked.',
        ref('Error'),
      ),
      ApiError: response('The request failed. Read error.code and error.message.', ref('Error')),
    },
  },
};
