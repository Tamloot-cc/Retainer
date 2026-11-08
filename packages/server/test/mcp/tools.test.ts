import { readFileSync } from 'node:fs';
import type { GetPromptResult } from '@modelcontextprotocol/client';
import { FIELD_TYPES, FIELD_VALUE_FORMATS } from '@retainer/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_NAMES, GUIDES } from '../../src/mcp/guides.js';
import { schemaOperationSchema } from '../../src/schema-engine/operations.js';
import { type McpTestClient, startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/** The guides that carry the shared schema design rules. */
const SCHEMA_GUIDE_NAMES = GUIDE_NAMES.filter((name) =>
  GUIDES[name].text.includes('### Use what Retainer already has'),
);

const db = useTestDatabase();
let t: TestApp;
let agent: McpTestClient;
let agent2: McpTestClient;
let user: McpTestClient;
let reader: McpTestClient;
let outsider: McpTestClient;
let fresh: McpTestClient;
let salesAgentKey: string;
let salesUserKey: string;
let salesAdminKey: string;
const clients: McpTestClient[] = [];

const TOOLS = [
  'apply_template',
  'describe_schema',
  'get_context',
  'get_guide',
  'get_record',
  'get_timeline',
  'list_comments',
  'list_templates',
  'log_event',
  'move_events',
  'propose_schema_change',
  'query_records',
  'remember',
  'search',
  'upsert_record',
];

async function toolsByName(client: McpTestClient) {
  const { tools } = await client.listTools();
  return new Map(tools.map((tool) => [tool.name, tool]));
}

beforeAll(async () => {
  t = startTestApp(db);
  const sales = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: {
        actor: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
        scopes: ['read', 'write', 'schema:write'],
      },
      agent2: { actor: { type: 'agent', id: 'calendar' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
      admin: { actor: { type: 'user', id: 'ops' }, scopes: ['admin'] },
    },
  );
  salesAgentKey = sales.keys.agent;
  salesUserKey = sales.keys.user;
  salesAdminKey = sales.keys.admin;
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  const blank = await t.setupWorkspace(
    { name: 'Yael Realty' },
    { agent: { actor: { type: 'agent', id: 'setup' }, scopes: ['read', 'write', 'schema:write'] } },
  );
  for (const [key, assign] of [
    [sales.keys.agent, (c: McpTestClient) => (agent = c)],
    [sales.keys.agent2, (c: McpTestClient) => (agent2 = c)],
    [sales.keys.user, (c: McpTestClient) => (user = c)],
    [sales.keys.reader, (c: McpTestClient) => (reader = c)],
    [other.keys.agent, (c: McpTestClient) => (outsider = c)],
    [blank.keys.agent, (c: McpTestClient) => (fresh = c)],
  ] as const) {
    const client = await t.mcpClient(key);
    clients.push(client);
    assign(client);
  }
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

let n = 0;
const email = () => `mcp${++n}@acme.test`;

const createPerson = async (values: Record<string, unknown> = {}) => {
  const res = await agent.call('upsert_record', {
    object: 'person',
    values: { name: { first: 'Dana', last: 'Levi' }, emails: email(), ...values },
  });
  expect(res.isError).toBe(false);
  return res.body as { id: string; record: { fields: Record<string, unknown> } };
};

describe('connecting', () => {
  it('includes a self-contained brand icon without requiring the web app', () => {
    const info = agent.getServerVersion();
    expect(info).toMatchObject({ name: 'retainer', title: 'Retainer' });
    const [icon] = info?.icons ?? [];
    expect(icon).toMatchObject({ mimeType: 'image/svg+xml', sizes: ['any'] });
    expect(icon?.src).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(icon?.src.split(',')[1] ?? '', 'base64').toString('utf8');
    const favicon = readFileSync(
      new URL('../../../web/public/favicon.svg', import.meta.url),
      'utf8',
    );
    expect(svg).toBe(favicon.trim());
  });

  it('rejects a request without an API key', async () => {
    const res = await t.request('/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an unknown API key', async () => {
    const res = await t.request('/mcp', {
      key: 'rtn_not_a_real_key',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(401);
  });

  it('serves clients that still speak the 2025 protocol', async () => {
    const post = async (body: unknown) => {
      const res = await t.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${salesAgentKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const data = text.split('\n').find((line) => line.startsWith('data: ')) ?? text;
      return JSON.parse(data.replace(/^data: /, ''));
    };
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'older-client', version: '1.0.0' },
      },
    });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const call = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'describe_schema', arguments: {} },
    });
    expect(JSON.parse(call.result.content[0].text).workspace.name).toBe('Acme Sales');
  });

  it('closes a subscriptions/listen stream at once, since its lists never change', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'listener', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${salesAgentKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'subscriptions/listen',
        params: {
          notifications: { toolsListChanged: true, promptsListChanged: true },
          _meta: meta,
        },
      }),
    });
    expect(res.status).toBe(200);
    // A stream left open never finishes this read; the test would time out.
    const text = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('the listen stream stayed open')), 2000),
      ),
    ]);
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(messages[0]).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: {} },
    });
    expect(messages.at(-1)).toMatchObject({ id: 7, result: { resultType: 'complete' } });
  });

  it('lists the tools, none of which takes a workspace', async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    // Events replaced interactions (9): log_event logs them, query_records lists them.
    expect(tools.map((tool) => tool.name)).not.toContain('log_interaction');
    expect(tools.map((tool) => tool.name)).not.toContain('query_interactions');
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('workspace');
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('actor');
    }
  });

  it('gives agents instructions that start from describe_schema', () => {
    expect(agent.getInstructions()).toContain('describe_schema');
  });

  it('spells out the memory workflow: log the event first, then cite it (4.1)', async () => {
    const instructions = agent.getInstructions() ?? '';
    const log = instructions.indexOf('1. log_event');
    expect(log).toBeGreaterThan(-1);
    expect(instructions.indexOf('2. upsert_record with source')).toBeGreaterThan(log);
    expect(instructions.indexOf('3. remember')).toBeGreaterThan(log);
    const byName = await toolsByName(agent);
    expect(byName.get('upsert_record')?.inputSchema.properties).toHaveProperty('source');
    expect(byName.get('upsert_record')?.description).toContain('log_event');
    expect(byName.get('remember')?.description).toContain('log_event');
    expect(byName.get('log_event')?.description).toContain('source');
    expect(byName.get('query_records')?.inputSchema.properties).toHaveProperty('linked');
  });
});

describe('event history and schema guidance', () => {
  it('distinguishes direct queries from rolled-up history in agent-facing metadata', async () => {
    const instructions = agent.getInstructions() ?? '';
    expect(instructions).toContain('directly attached');
    expect(instructions).toContain('one-hop event');
    const byName = await toolsByName(agent);
    const query = byName.get('query_records')?.description ?? '';
    expect(query).toContain('direct attachments only');
    expect(query).toContain('get_context');
    expect(query).toContain('get_timeline');
    for (const name of ['get_context', 'get_timeline']) {
      expect(byName.get(name)?.description).toContain('one hop');
    }
    const schema = byName.get('describe_schema')?.description ?? '';
    for (const marker of [
      'isProtected',
      'protectedOptions',
      'baseObject',
      'baseField',
      'coreRole',
    ]) {
      expect(schema).toContain(marker);
    }
    expect(schema).toContain('current API');
  });

  it.each(SCHEMA_GUIDE_NAMES)(
    '%s explains rollup limits and protected schema markers',
    async (name) => {
      const { body } = await reader.call<string>('get_guide', { name });
      expect(body).toContain('one hop from source to target');
      expect(body).toContain('Only events roll up, not field');
      expect(body).toContain('query_records with linked returns direct attachments only');
      expect(body).toContain('Protected objects cannot be deleted');
      expect(body).toContain('protected option values cannot be removed');
      expect(body).toContain('Use baseObject and baseField');
      expect(body).toContain('current API names');
    },
  );

  it('warns that moving events between types is not a quick cleanup', async () => {
    const { body } = await reader.call<string>('get_guide', { name: 'schema_design' });
    const review = body.slice(body.indexOf('## Reviewing a schema in use'));
    expect(review).toContain('entity objects (class "entity")');
    expect(review).toContain('Moving legacy entity records');
    expect(review).toContain('Never delete and re-log their');
    expect(review).toContain('move_events changes their type in place');
    expect(review).toContain('Run it with dryRun: true');
  });

  it.each(SCHEMA_GUIDE_NAMES)(
    '%s steers conversations to medium and new types to the D4 rule',
    async (name) => {
      const { body } = await reader.call<string>('get_guide', { name });
      expect(body).toContain('one event type, conversation');
      expect(body).toContain('Add an event type only when the event has fields a conversation');
      expect(body).toContain('channel is where an event came from');
      expect(body).not.toMatch(/Meetings, calls, emails, messages and notes are events/);
    },
  );

  it('tells agents to log conversations with a medium, and channel apart from medium', async () => {
    const instructions = agent.getInstructions() ?? '';
    expect(instructions).toContain(
      'Log meetings, calls, emails and chats as conversation with a medium. Use\nanother event ' +
        'type only when the workspace defines one for that kind of event.',
    );
    const byName = await toolsByName(agent);
    expect(byName.get('log_event')?.description).toContain(
      'Log meetings, calls, emails and chats as conversation with a medium.',
    );
    expect(byName.get('describe_schema')?.description).toContain('medium');
    expect(JSON.stringify(byName.get('log_event')?.inputSchema)).toContain('not the channel');
  });
});

describe('the discover_schema guide', () => {
  it('points a new workspace at the guide from the instructions', () => {
    expect(fresh.getInstructions()).toContain('get_guide("discover_schema")');
  });

  it('serves the guide as markdown to any key that can read', async () => {
    const res = await reader.call<string>('get_guide', { name: 'discover_schema' });
    expect(res.isError).toBe(false);
    expect(res.body).toMatch(/^# Discover the schema/);
    const steps = [
      'describe_schema',
      'Propose and wait',
      'apply_template',
      'propose_schema_change',
    ];
    const positions = steps.map((step) => res.body.indexOf(step));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each(GUIDE_NAMES)(
    '%s names only tools, operations, field types and guides that exist',
    async (name) => {
      const res = await agent.call<string>('get_guide', { name });
      const operations = schemaOperationSchema.options.map((o) => o.shape.op.value);
      const cardinalities = ['many_to_one', 'many_to_many', 'one_to_many'];
      const known = new Set<string>([
        ...TOOLS,
        ...operations,
        ...FIELD_TYPES,
        ...GUIDE_NAMES,
        ...cardinalities,
      ]);
      const named = new Set(res.body.match(/\b[a-z]+(?:_[a-z]+)+\b/g));
      expect(named).toContain('log_event');
      expect([...named].filter((word) => !known.has(word))).toEqual([]);
    },
  );

  it('rejects an unknown guide and lists the known ones', async () => {
    const res = await agent.call('get_guide', { name: 'import_data' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('discover_schema');
  });

  it('offers every guide as a prompt of the same name', async () => {
    const { prompts } = await fresh.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([...GUIDE_NAMES].sort());
  });

  it('starts discover_schema as a prompt, with the sources the user names', async () => {
    const promptText = ({ messages: [message] }: GetPromptResult) => {
      expect(message?.role).toBe('user');
      return message?.content.type === 'text' ? message.content.text : '';
    };
    const { prompts } = await fresh.listPrompts();
    expect(prompts.find((prompt) => prompt.name === 'discover_schema')?.arguments).toEqual([
      expect.objectContaining({ name: 'sources', required: false }),
    ]);

    const guide = await fresh.call<string>('get_guide', { name: 'discover_schema' });
    const plain = promptText(await fresh.getPrompt({ name: 'discover_schema' }));
    expect(plain).toContain(guide.body);
    expect(plain).not.toContain('Start with these sources');

    const named = promptText(
      await fresh.getPrompt({
        name: 'discover_schema',
        arguments: { sources: 'Gmail and the leads spreadsheet' },
      }),
    );
    expect(named).toContain('Start with these sources: Gmail and the leads spreadsheet');
  });
});

describe('the schema_design guide', () => {
  it('points agents at the guide where they change the schema', async () => {
    expect(agent.getInstructions()).toContain('get_guide("schema_design")');
    const byName = await toolsByName(agent);
    const propose = byName.get('propose_schema_change')?.description ?? '';
    expect(propose).toContain('get_guide("schema_design")');
    expect(propose).toContain('log_event');
    expect(byName.get('list_templates')?.description).toContain('initialized');
  });

  it('serves the guide with the same design rules as discover_schema', async () => {
    const [design, discover] = await Promise.all([
      reader.call<string>('get_guide', { name: 'schema_design' }),
      reader.call<string>('get_guide', { name: 'discover_schema' }),
    ]);
    expect(design.isError).toBe(false);
    expect(design.body).toMatch(/^# Design and grow the schema/);
    const rules = design.body.slice(design.body.indexOf('### Use what Retainer already has'));
    const shared = rules.slice(0, rules.indexOf('## Reviewing'));
    expect(shared.length).toBeGreaterThan(500);
    expect(discover.body).toContain(shared.trim());
  });
});

describe('the log_from_chat guide', () => {
  it('points agents at the guide from the instructions', () => {
    expect(agent.getInstructions()).toContain('get_guide("log_from_chat")');
  });

  it('logs the source before the values, facts and tasks that cite it', async () => {
    const { body, isError } = await reader.call<string>('get_guide', { name: 'log_from_chat' });
    expect(isError).toBe(false);
    expect(body).toMatch(/^# Log what your user tells you/);
    const steps = ['get_context', 'log_event', 'order the server instructions give'];
    const positions = steps.map((step) => body.indexOf(step));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('cites the email or meeting itself, not the chat, when that is where it came from', async () => {
    const { body } = await reader.call<string>('get_guide', { name: 'log_from_chat' });
    const prose = body.replace(/\s+/g, ' ');
    expect(prose).toContain('Reading it does not make the chat its source.');
    expect(prose).toContain('channel set to your client ("claude-code"');
    expect(prose).toContain('Each turn you log is its own event');
    expect(prose).toContain('Ask your user before creating a company');
  });
});

describe('describe_schema, list_templates and apply_template', () => {
  it('shows a new workspace as not initialized, then applies a template', async () => {
    const before = await fresh.call('describe_schema');
    expect(before.isError).toBe(false);
    expect(before.body.workspace).toMatchObject({
      name: 'Yael Realty',
      initialized: false,
      templates: [],
    });
    // Every workspace starts with the base objects and event types (6.1).
    expect(before.body.objects.map((o: { nameSingular: string }) => o.nameSingular).sort()).toEqual(
      ['company', 'conversation', 'person', 'task'],
    );

    const list = await fresh.call('list_templates');
    const realEstate = list.body.templates.find((x: { name: string }) => x.name === 'real_estate');
    expect(realEstate).toMatchObject({ applied: false });
    expect(realEstate.adds.objects.map((o: { name: string }) => o.name).sort()).toEqual([
      'property',
      'viewing',
    ]);

    expect(realEstate.version).toBe(2);
    const fieldsOf = (name: string) =>
      realEstate.adds.objects.find((o: { name: string }) => o.name === name).fields;
    expect(fieldsOf('property')).toContain('owner');
    expect(fieldsOf('viewing')).toContain('status');

    const applied = await fresh.call('apply_template', { name: 'real_estate' });
    expect(applied.isError).toBe(false);
    expect(applied.body).toMatchObject({ status: 'applied', alreadyApplied: false });

    const again = await fresh.call('apply_template', { name: 'real_estate' });
    expect(again.body).toMatchObject({ status: 'unchanged', alreadyApplied: true });

    const after = await fresh.call('describe_schema');
    expect(after.body.workspace.initialized).toBe(true);
    expect(after.body.workspace.schemaVersion).toBeGreaterThan(before.body.workspace.schemaVersion);
    expect(after.body.objects.map((o: { nameSingular: string }) => o.nameSingular)).toContain(
      'viewing',
    );
  });

  it('names the templates when one is unknown', async () => {
    const res = await fresh.call('apply_template', { name: 'dentist' });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.details.templates).toContain('sales');
  });

  it('states the value format of every field type the schema uses (9.3)', async () => {
    const res = await agent.call('describe_schema');
    const objects = res.body.objects as { fields: { type: string }[] }[];
    const used = new Set(objects.flatMap((o) => o.fields.map((f) => f.type)));
    expect(Object.keys(res.body.valueFormats).sort()).toEqual([...used].sort());
    expect(res.body.valueFormats).toMatchObject({
      full_name: FIELD_VALUE_FORMATS.full_name,
      emails: FIELD_VALUE_FORMATS.emails,
      phones: FIELD_VALUE_FORMATS.phones,
    });
    const byName = await toolsByName(agent);
    expect(byName.get('describe_schema')?.description).toContain('valueFormats');
    expect(JSON.stringify(byName.get('upsert_record')?.inputSchema)).toContain('valueFormats');
  });

  it('returns the same description as GET /v1/schema', async () => {
    const mcp = await agent.call('describe_schema');
    const rest = await t.request('/v1/schema', { key: salesAgentKey });
    expect(mcp.body).toEqual(rest.body);
  });

  it('lists event types as objects of class "event", and facts as the one built-in', async () => {
    const res = await agent.call('describe_schema');
    expect(res.body.builtIns.map((b: { name: string }) => b.name)).toEqual(['fact', 'comment']);
    expect(res.body.builtIns[0].writeWith).toContain('remember');
    const objects = res.body.objects as { nameSingular: string; class: string }[];
    const events = objects.filter((o) => o.class === 'event').map((o) => o.nameSingular);
    expect(events.sort()).toEqual(['conversation']);
    expect(objects.find((o) => o.nameSingular === 'person')?.class).toBe('entity');
    // Neither interactions nor the hidden internal-note type are listed.
    expect(objects.map((o) => o.nameSingular)).not.toContain('interaction');
    expect(JSON.stringify(res.body)).not.toMatch(/internal.?note/i);
  });
});

describe('upsert_record', () => {
  it('creates a record attributed to the key, never to the payload', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      values: { name: { first: 'Ron', last: 'Peretz' }, emails: email() },
    });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({
      created: true,
      fields: { name: 'applied', emails: 'applied' },
      record: { createdBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' } },
    });
  });

  it('rejects an actor smuggled into the arguments', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
      actor: { type: 'user', id: 'maya' },
    });
    expect(res.isError).toBe(true);
  });

  it('updates by match and fails on a miss unless ifMissing is "create"', async () => {
    const person = await createPerson();
    const address = (await agent.call('get_record', { id: person.id })).body.fields.emails
      .primary as string;

    const updated = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: address },
      values: { address: { street1: '12 Rothschild Blvd', city: 'Tel Aviv', country: 'IL' } },
    });
    expect(updated.body).toMatchObject({
      id: person.id,
      created: false,
      fields: { address: 'applied' },
    });

    const missing = email();
    const miss = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: missing },
      values: { jobTitle: 'COO' },
    });
    expect(miss.isError).toBe(true);
    expect(miss.body.error).toMatchObject({ code: 'not_found' });
    expect(miss.body.error.message).toContain('ifMissing: "create"');

    const created = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: missing },
      ifMissing: 'create',
      values: { jobTitle: 'COO' },
    });
    expect(created.body).toMatchObject({
      created: true,
      fields: { emails: 'applied', jobTitle: 'applied' },
    });
  });

  it('names the expected format when a composite value has the wrong shape (9.3)', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      values: {
        name: { firstName: 'Dana', lastName: 'Levi' },
        emails: { primaryEmail: email(), additionalEmails: [] },
      },
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('invalid_values');
    const errors = res.body.error.details.errors as {
      field: string;
      message: string;
      expected?: string;
    }[];
    expect(errors.find((e) => e.field === 'name')).toMatchObject({
      message: expect.stringContaining('firstName'),
      expected: FIELD_VALUE_FORMATS.full_name,
    });
    expect(errors.find((e) => e.field === 'emails')).toMatchObject({
      message: expect.stringContaining('primaryEmail'),
      expected: FIELD_VALUE_FORMATS.emails,
    });

    // Rewritten as the format says, the same values are accepted.
    const fixed = await agent.call('upsert_record', {
      object: 'person',
      values: {
        name: { first: 'Dana', last: 'Levi' },
        emails: { primary: email(), additional: [] },
      },
    });
    expect(fixed.isError).toBe(false);
    expect(fixed.body.fields).toMatchObject({ name: 'applied', emails: 'applied' });
  });

  it('rejects a match on phones and points to query_records', async () => {
    const res = await agent.call('upsert_record', {
      object: 'person',
      match: { phones: '+972545550199' },
      values: {},
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toMatchObject({
      code: 'invalid_match',
      details: { field: 'phones', allowed: ['emails'] },
    });
    expect(res.body.error.message).toContain('query_records');
  });

  it('names the field and the allowed options on a validation error, and writes nothing', async () => {
    const deal = await agent.call('upsert_record', {
      object: 'deal',
      values: { name: 'Acme renewal', stage: 'negotiation' },
    });
    const bad = await agent.call('upsert_record', {
      object: 'deal',
      id: deal.body.id,
      values: { stage: 'closed_won', amount: { amountMicros: 52_000_000_000, currency: 'USD' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatchObject({
      code: 'invalid_values',
      details: {
        errors: [
          {
            field: 'stage',
            message: 'expected one of the options',
            allowed: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
          },
        ],
      },
    });
    const unchanged = await agent.call('get_record', { id: deal.body.id });
    expect(unchanged.body.fields.amount).toBeUndefined();
    expect(unchanged.body.fields.stage).toBe('negotiation');

    const retry = await agent.call('upsert_record', {
      object: 'deal',
      id: deal.body.id,
      values: { stage: 'won', amount: { amountMicros: 52_000_000_000, currency: 'USD' } },
    });
    expect(retry.body.fields).toEqual({ stage: 'applied', amount: 'applied' });
  });

  it('holds an agent value that disagrees with a person as pending_review', async () => {
    const person = await createPerson();
    const set = await user.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'VP Operations' },
    });
    expect(set.body.fields).toEqual({ jobTitle: 'applied' });

    const res = await agent.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'COO' },
    });
    expect(res.isError).toBe(false);
    expect(res.body.fields).toEqual({ jobTitle: 'pending_review' });
    expect(res.body.record.fields.jobTitle).toBe('VP Operations');
  });

  it('replays a create with the same idempotency key', async () => {
    const args = {
      object: 'person',
      values: { name: { first: 'Noa', last: 'Shapira' }, emails: email() },
      idempotencyKey: `create-${n}`,
    };
    const first = await agent.call('upsert_record', args);
    const second = await agent.call('upsert_record', args);
    expect(first.body.created).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it('rejects an idempotency key on a write by id or match', async () => {
    const person = await createPerson();
    const res = await agent.call('upsert_record', {
      object: 'person',
      id: person.id,
      values: { jobTitle: 'CFO' },
      idempotencyKey: 'not-for-updates',
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('ends two concurrent creates of one email on one record', async () => {
    const shared = email();
    const write = (client: McpTestClient, values: Record<string, unknown>) =>
      client.call('upsert_record', {
        object: 'person',
        match: { emails: shared },
        ifMissing: 'create',
        values,
      });
    const results = await Promise.all([
      write(agent, { name: { first: 'Ron', last: 'Peretz' }, jobTitle: 'Procurement lead' }),
      write(agent2, { name: { first: 'Ron', last: 'Peretz' } }),
      write(agent, { jobTitle: 'Procurement lead' }),
      write(agent2, { jobTitle: 'Procurement' }),
    ]);
    for (const r of results) expect(r.isError).toBe(false);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.body.created)).toHaveLength(1);

    const found = await agent.call('query_records', {
      object: 'person',
      filter: { id: { eq: results[0]?.body.id } },
    });
    expect(found.body.records).toHaveLength(1);
  });
});

describe('query_records and get_record', () => {
  it('filters and reads records', async () => {
    const person = await createPerson({ jobTitle: 'Head of Data' });
    const res = await agent.call('query_records', {
      object: 'person',
      filter: { jobTitle: 'Head of Data' },
    });
    expect(res.isError).toBe(false);
    expect(res.body.records.map((r: { id: string }) => r.id)).toContain(person.id);

    const one = await agent.call('get_record', { id: person.id });
    expect(one.body).toMatchObject({ id: person.id, object: 'person', label: 'Dana Levi' });
  });

  it('reports a bad filter with the allowed operators', async () => {
    const res = await agent.call('query_records', {
      object: 'person',
      filter: { createdAt: { like: '2026' } },
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('invalid_filter');
    expect(res.body.error.details.allowed).toContain('gte');
  });

  it("does not show another workspace's records", async () => {
    const person = await createPerson();
    const res = await outsider.call('get_record', { id: person.id });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
  });

  it('reports an unknown object', async () => {
    const res = await agent.call('query_records', { object: 'spaceship' });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('propose_schema_change', () => {
  it('applies an additive change and proposes a destructive one', async () => {
    const added = await agent.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'preferredLanguage',
            label: 'Preferred language',
            type: 'select',
            isFilterable: true,
            settings: {
              options: [
                { value: 'he', label: 'Hebrew' },
                { value: 'en', label: 'English' },
              ],
            },
          },
        },
      ],
      reason: 'Contacts state a preferred language in most calls.',
    });
    expect(added.isError).toBe(false);
    expect(added.body.status).toBe('applied');

    const write = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email(), preferredLanguage: 'he' },
    });
    expect(write.body.fields.preferredLanguage).toBe('applied');

    const removal = await agent.call('propose_schema_change', {
      operations: [{ op: 'delete_field', object: 'person', field: 'preferredLanguage' }],
      reason: 'No longer needed.',
    });
    expect(removal.isError).toBe(false);
    expect(removal.body.status).toBe('proposed');

    const schema = await agent.call('describe_schema');
    const person = schema.body.objects.find(
      (o: { nameSingular: string }) => o.nameSingular === 'person',
    );
    expect(person.fields.map((f: { name: string }) => f.name)).toContain('preferredLanguage');
  });

  it('reports an invalid change with its issues', async () => {
    const res = await agent.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'emails', label: 'Emails again', type: 'text' },
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe('schema_invalid');
  });
});

describe('scopes', () => {
  it('lets a read-only key read but not write', async () => {
    const read = await reader.call('describe_schema');
    expect(read.isError).toBe(false);

    const write = await reader.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
    });
    expect(write.isError).toBe(true);
    expect(write.body.error).toMatchObject({ code: 'forbidden', details: { required: 'write' } });
  });

  it('needs schema:write for schema changes and templates', async () => {
    const change = await agent2.call('propose_schema_change', {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'nickname', label: 'Nickname', type: 'text' },
        },
      ],
    });
    expect(change.body.error).toMatchObject({
      code: 'forbidden',
      details: { required: 'schema:write' },
    });

    const template = await agent2.call('apply_template', { name: 'recruiting' });
    expect(template.body.error.code).toBe('forbidden');
  });
});

describe('the memory workflow (4.1): log_event, then cite it', () => {
  let external = 0;
  const logCall = async (args: Record<string, unknown> = {}, client = agent) =>
    client.call('log_event', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      ...args,
    });

  it('logs an event and returns matched and unmatched participants (6.2)', async () => {
    const dana = await createPerson();
    const danaEmail = dana.record.fields.emails as { primary: string };
    const res = await logCall({
      externalId: `zoom-${++external}`,
      title: 'Acme renewal call',
      summary: 'Discussed the renewal.',
      participants: [
        { handle: danaEmail.primary, role: 'customer' },
        { handle: 'ron.peretz@acme.test', role: 'customer' },
        { handle: '+972 54 123 4567', role: 'customer' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.body).toEqual({
      id: expect.any(String),
      type: 'conversation',
      created: true,
      participants: {
        matched: [
          {
            id: expect.any(String),
            handle: danaEmail.primary,
            role: 'customer',
            recordId: dana.id,
          },
        ],
        unmatched: [
          {
            id: expect.any(String),
            handle: 'ron.peretz@acme.test',
            role: 'customer',
            reason: 'no_match',
          },
          {
            id: expect.any(String),
            handle: '+972541234567',
            role: 'customer',
            reason: 'phone_only',
          },
        ],
      },
      about: [],
    });
  });

  it('links the records an event is about, and finds it with query_records and linked (7.1)', async () => {
    const dana = await createPerson();
    const acme = await agent.call('upsert_record', {
      object: 'company',
      values: { name: 'Acme MCP' },
    });
    const externalId = `zoom-${++external}`;
    const first = await logCall({ externalId, participants: [{ recordId: dana.id }] });
    const again = await logCall({
      externalId,
      participants: [{ recordId: dana.id }],
      about: [acme.body.id],
    });
    expect(again.body).toMatchObject({
      id: first.body.id,
      created: false,
      about: [acme.body.id],
      added: { about: [acme.body.id] },
    });

    const found = await agent.call('query_records', {
      object: 'conversation',
      linked: { record: acme.body.id, link: 'about' },
    });
    expect(found.isError).toBe(false);
    expect(found.body).toMatchObject({ nextCursor: null });
    expect(found.body.records.map((r: { id: string }) => r.id)).toEqual([first.body.id]);
    expect(found.body.records[0]).toMatchObject({
      object: 'conversation',
      event: { channel: 'zoom', externalId, about: [acme.body.id] },
    });
    // Dana is a participant, not an about record.
    const asParticipant = await agent.call('query_records', {
      object: 'conversation',
      linked: { record: dana.id, link: 'participant' },
    });
    expect(asParticipant.body.records.map((r: { id: string }) => r.id)).toEqual([first.body.id]);
    const notAbout = await agent.call('query_records', {
      object: 'conversation',
      linked: { record: dana.id, link: 'about' },
    });
    expect(notAbout.body.records).toEqual([]);

    const context = await agent.call('get_context', { record: acme.body.id });
    expect(context.body.recentEvents).toEqual([
      expect.objectContaining({ id: first.body.id, type: 'conversation', via: { kind: 'about' } }),
    ]);
  });

  it('returns one event for concurrent calls with the same externalId', async () => {
    const args = { externalId: `zoom-${++external}`, title: 'Concurrent call' };
    const results = await Promise.all([
      logCall(args, agent),
      logCall(args, agent),
      logCall(args, agent2),
      logCall(args, agent2),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.body.created)).toHaveLength(1);

    const conflict = await logCall({ ...args, title: 'Edited title' });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.error).toMatchObject({ code: 'event_conflict' });
  });

  it('cites the event in upsert_record, so an older email loses to a newer call', async () => {
    const dana = await createPerson();
    const call = await logCall({ occurredAt: '2026-10-28T10:00:00Z' });
    const mail = await logCall({
      type: 'conversation',
      channel: 'gmail',
      occurredAt: '2026-09-01T10:00:00Z',
    });
    const fromCall = await agent.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'VP Sales' },
      source: call.body.id,
    });
    expect(fromCall.body.fields).toEqual({ jobTitle: 'applied' });
    const fromMail = await agent2.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'Sales Director' },
      source: mail.body.id,
    });
    expect(fromMail.body.fields).toEqual({ jobTitle: 'superseded' });
    expect(fromMail.body.record.fields.jobTitle).toBe('VP Sales');

    const created = await agent.call('upsert_record', {
      object: 'person',
      values: { emails: email() },
      source: call.body.id,
    });
    expect(created.body.created).toBe(true);

    const unknown = await agent.call('upsert_record', {
      object: 'person',
      id: dana.id,
      values: { jobTitle: 'CEO' },
      source: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error.code).toBe('invalid_source');
    expect(unknown.body.error.message).toContain('log_event');
  });

  it('remembers a fact citing the event (6.2)', async () => {
    const dana = await createPerson();
    const call = await logCall();
    const res = await agent.call('remember', {
      record: dana.id,
      text: 'Legal review at Acme usually takes two weeks.',
      source: call.body.id,
      quote: 'legal usually needs two weeks with these',
    });
    expect(res.isError).toBe(false);
    expect(res.body).toEqual({
      fact: {
        id: expect.any(String),
        record: dana.id,
        content: 'Legal review at Acme usually takes two weeks.',
        kind: 'stated',
        validFrom: '2026-10-29T12:00:00.000Z',
        validTo: null,
        writtenBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
        sources: [{ event: call.body.id, quote: 'legal usually needs two weeks with these' }],
      },
    });

    // Without a source the fact rests on an internal note, which has no
    // readable ID (6.4).
    const note = await agent.call('remember', { record: dana.id, text: 'Prefers WhatsApp.' });
    expect(Object.keys(note.body)).toEqual(['fact']);
    expect(note.body.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
  });

  it('replays concurrent remember calls with the same idempotency key', async () => {
    const dana = await createPerson();
    const args = { record: dana.id, text: 'Budget approved for Q1.', idempotencyKey: 'mcp-fact-1' };
    const results = await Promise.all([
      agent.call('remember', args),
      agent.call('remember', args),
      agent.call('remember', args),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(new Set(results.map((r) => r.body.fact.id)).size).toBe(1);
    for (const result of results) expect(result.body).toEqual(results[0]?.body);
    const pack = await agent.call('get_context', { record: dana.id });
    expect(pack.body.facts).toEqual([
      expect.objectContaining({ content: 'Budget approved for Q1.', internal: true }),
    ]);
  });

  it('needs the write scope to log or remember', async () => {
    const dana = await createPerson();
    const logged = await logCall({}, reader);
    expect(logged.isError).toBe(true);
    expect(logged.body.error.code).toBe('forbidden');
    const remembered = await reader.call('remember', { record: dana.id, text: 'x' });
    expect(remembered.body.error.code).toBe('forbidden');
  });

  it("cannot cite or remember on another workspace's data", async () => {
    const dana = await createPerson();
    const theirs = await logCall({}, outsider);
    const res = await agent.call('remember', {
      record: dana.id,
      text: 'x',
      source: theirs.body.id,
    });
    expect(res.body.error.code).toBe('invalid_source');
    const foreign = await outsider.call('remember', { record: dana.id, text: 'x' });
    expect(foreign.body.error.code).toBe('not_found');
  });
});

describe('events are records (6.2, 7.1)', () => {
  const logMeeting = (args: Record<string, unknown>) =>
    agent.call('log_event', { type: 'conversation', channel: 'calendar', ...args });

  it('lists the events linked to a record with query_records, by built-in column', async () => {
    const dana = await createPerson();
    const ids: string[] = [];
    for (const [day, channel] of [
      ['01', 'calendar'],
      ['03', 'calendar'],
      ['02', 'teams'],
    ] as const) {
      const res = await logMeeting({
        channel,
        occurredAt: `2026-10-${day}T09:00:00Z`,
        title: `Sync ${day}`,
        participants: [{ recordId: dana.id }],
      });
      expect(res.isError).toBe(false);
      ids.push(res.body.id);
    }
    await logMeeting({ occurredAt: '2026-10-04T09:00:00Z', title: 'Without Dana' });

    const newest = await agent.call('query_records', {
      object: 'conversation',
      linked: { record: dana.id },
      sort: [{ field: 'occurredAt', direction: 'desc' }],
    });
    expect(newest.isError).toBe(false);
    expect(newest.body.records.map((r: { id: string }) => r.id)).toEqual([ids[1], ids[2], ids[0]]);
    const onCalendar = await agent.call('query_records', {
      object: 'conversation',
      linked: { record: dana.id, link: 'participant' },
      filter: { channel: 'calendar', occurredAt: { gte: '2026-10-02T00:00:00Z' } },
    });
    expect(onCalendar.body.records.map((r: { id: string }) => r.id)).toEqual([ids[1]]);

    // linked applies to event types only.
    const entity = await agent.call('query_records', {
      object: 'company',
      linked: { record: dana.id },
    });
    expect(entity.isError).toBe(true);
    expect(entity.body.error.details).toMatchObject({ field: 'linked' });
  });

  it('queries every event type at once with object "event"', async () => {
    const dana = await createPerson();
    const call = await logMeeting({
      occurredAt: '2026-10-06T09:00:00Z',
      title: 'Call with Dana',
      fields: { medium: 'call' },
      participants: [{ recordId: dana.id }],
    });
    // A second event type, the kind a workspace adds for what a conversation can't hold.
    const added = await agent.call('propose_schema_change', {
      reason: 'A second event type',
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'payment',
            namePlural: 'payments',
            labelSingular: 'Payment',
            labelPlural: 'Payments',
            fields: [],
          },
        },
      ],
    });
    expect(added.body.status).toBe('applied');
    const note = await agent.call('log_event', {
      type: 'payment',
      channel: 'web',
      occurredAt: '2026-10-07T09:00:00Z',
      title: 'Dana prefers mornings',
      about: [dana.id],
    });
    expect(note.isError).toBe(false);
    await agent.call('remember', { record: dana.id, text: 'Dana runs ops.' });

    const all = await agent.call('query_records', { object: 'event', linked: { record: dana.id } });
    expect(all.isError).toBe(false);
    expect(all.body.records.map((r: { id: string; type: string }) => [r.id, r.type])).toEqual([
      [note.body.id, 'payment'],
      [call.body.id, 'conversation'],
    ]);
    expect(all.body.records[1].fields.medium).toBe('call');

    const notes = await agent.call('query_records', {
      object: 'event',
      linked: { record: dana.id },
      filter: { type: { in: ['payment'] } },
    });
    expect(notes.body.records.map((r: { id: string }) => r.id)).toEqual([note.body.id]);
    const medium = await agent.call('query_records', {
      object: 'event',
      filter: { medium: 'call' },
    });
    expect(medium.isError).toBe(true);
    expect(medium.body.error.code).toBe('invalid_filter');
  });

  it('refuses to create an event with upsert_record, but edits one that exists', async () => {
    const created = await agent.call('upsert_record', {
      object: 'conversation',
      values: { title: 'Made up' },
    });
    expect(created.isError).toBe(true);
    expect(created.body.error).toMatchObject({
      code: 'use_log_event',
      details: { object: 'conversation' },
    });
    expect(created.body.error.message).toContain('log_event');

    const logged = await logMeeting({
      occurredAt: '2026-10-05T09:00:00Z',
      externalId: 'mcp-edit-1',
      title: 'Kickoff',
    });
    const edited = await agent.call('upsert_record', {
      object: 'conversation',
      id: logged.body.id,
      values: { title: 'Kickoff with Acme' },
    });
    expect(edited.isError).toBe(false);
    expect(edited.body).toMatchObject({ id: logged.body.id, created: false });
    expect(edited.body.record.event).toMatchObject({ title: 'Kickoff with Acme' });
    // Retries compare with what was first logged, so the edit does not break them.
    const retry = await logMeeting({
      occurredAt: '2026-10-05T09:00:00Z',
      externalId: 'mcp-edit-1',
      title: 'Kickoff',
    });
    expect(retry.body).toMatchObject({ id: logged.body.id, created: false });
  });

  it('refuses an unknown or entity type, and the reserved channel', async () => {
    const base = { channel: 'zoom', occurredAt: '2026-10-05T09:00:00Z' };
    const entity = await agent.call('log_event', { ...base, type: 'person' });
    expect(entity.body.error).toMatchObject({ code: 'not_an_event_type' });
    expect(entity.body.error.details.eventTypes).toEqual(
      expect.arrayContaining(['conversation', 'payment']),
    );
    const unknown = await agent.call('log_event', { ...base, type: 'interaction' });
    expect(unknown.body.error.code).toBe('not_found');
    const reserved = await agent.call('log_event', {
      ...base,
      type: 'conversation',
      channel: 'retainer',
    });
    expect(reserved.isError).toBe(true);
    expect(JSON.stringify(reserved.body)).toContain('reserved');
  });
});

describe('finding and reading a record (5): search, then get_context', () => {
  it('finds a misspelled name, then reads its values, facts and events', async () => {
    const dana = await createPerson({ name: 'Dana Mizrahi-Katz', jobTitle: 'CFO' });
    const danaEmail = (dana.record.fields.emails as { primary: string }).primary;
    const call = await agent.call('log_event', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      title: 'Budget planning',
      participants: [{ handle: danaEmail }],
    });
    await agent.call('remember', {
      record: dana.id,
      text: 'Signs off on anything above 50k.',
      source: call.body.id,
    });

    const found = await reader.call('search', { query: 'Dana Mizrahi-Kats' });
    expect(found.isError).toBe(false);
    expect(found.body.records).toEqual([
      { id: dana.id, object: 'person', label: 'Dana Mizrahi-Katz', match: 'similar_label' },
    ]);
    const byFact = await reader.call('search', { query: '"signs off" OR nothingmatches' });
    expect(byFact.body.facts).toMatchObject([{ record: dana.id }]);

    const pack = await reader.call('get_context', { record: dana.id, tokenBudget: 500 });
    expect(pack.isError).toBe(false);
    expect(pack.body.record.fields.jobTitle).toEqual({
      value: 'CFO',
      writtenBy: { type: 'agent', id: 'inbox', name: 'Inbox agent' },
      observedAt: expect.any(String),
    });
    expect(pack.body.facts).toMatchObject([
      { content: 'Signs off on anything above 50k.', sources: [call.body.id] },
    ]);
    expect(pack.body.recentEvents).toMatchObject([
      {
        id: call.body.id,
        type: 'conversation',
        title: 'Budget planning',
        via: { kind: 'participant' },
      },
    ]);
    expect(pack.body.tokenEstimate).toBeLessThanOrEqual(500);

    const history = await reader.call('get_timeline', { record: dana.id });
    expect(history.isError).toBe(false);
    expect(history.body.items.map((i: { kind: string }) => i.kind)).toEqual(
      expect.arrayContaining(['event', 'field_change', 'fact']),
    );
    const titles = await reader.call('get_timeline', { record: dana.id, fields: ['jobTitle'] });
    expect(titles.body.items).toMatchObject([
      { kind: 'field_change', field: 'jobTitle', value: 'CFO', current: true },
    ]);
  });

  it('names the problem in validation errors and stays in its workspace', async () => {
    const bad = await agent.call('get_context', { record: 'not-an-id' });
    expect(bad.isError).toBe(true);
    const tooBig = await agent.call('get_context', {
      record: '00000000-0000-4000-8000-000000000000',
      tokenBudget: 99_999,
    });
    expect(tooBig.isError).toBe(true);
    const dana = await createPerson({ name: 'Ofri Ben-Ami' });
    const foreign = await outsider.call('get_context', { record: dana.id });
    expect(foreign.body.error.code).toBe('not_found');
    const nothing = await outsider.call('search', { query: 'Ofri' });
    expect(nothing.body).toEqual({ records: [], facts: [], events: [] });
  });
});

describe('after a person merges and forgets (4.2, 2.1)', () => {
  it('shows the survivor for a merged ID and never brings a forgotten person back', async () => {
    // The agent created a duplicate; a person merges it over REST.
    const merav = await createPerson({ name: { first: 'Merav', last: 'Golan' } });
    const duplicate = await createPerson({ name: { first: 'Merav', last: 'Golan' } });
    const merged = await t.request(`/v1/records/${merav.id}/merge`, {
      key: salesUserKey,
      body: { recordId: duplicate.id },
    });
    expect(merged.status).toBe(200);
    const read = await agent.call('get_record', { id: duplicate.id });
    expect(read.isError).toBe(false);
    expect(read.body.id).toBe(merav.id);
    const emails = read.body.fields.emails as { primary: string; additional: string[] };
    expect(emails.additional).toHaveLength(1);

    // She asks to be forgotten.
    const forgotten = await t.request(`/v1/records/${merav.id}/forget`, {
      key: salesAdminKey,
      method: 'POST',
    });
    expect(forgotten.status).toBe(200);
    const gone = await agent.call('get_record', { id: merav.id });
    expect(gone.body.error.code).toBe('not_found');

    // Later the agent logs a meeting with her: the handle is not stored, and
    // creating her again is refused.
    const logged = await agent.call('log_event', {
      type: 'conversation',
      channel: 'calendar',
      occurredAt: '2026-10-30T09:00:00Z',
      participants: [{ handle: emails.primary, role: 'customer' }],
    });
    expect(logged.body.participants.unmatched).toEqual([
      { id: expect.any(String), handle: null, role: 'customer', reason: 'suppressed' },
    ]);
    const again = await agent.call('upsert_record', {
      object: 'person',
      match: { emails: emails.primary },
      values: { name: { first: 'Merav', last: 'Golan' } },
      ifMissing: 'create',
    });
    expect(again.isError).toBe(true);
    expect(again.body.error.code).toBe('suppressed');
  });
});
