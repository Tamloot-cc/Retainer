import type { Invocation } from '@retainer/extension';
import { describe, expect, it, vi } from 'vitest';
import { executeTamloot } from './tamloot.js';
import { answerSchema } from './tamloot-configure.js';
import { TAMLOOT, TAMLOOT_MODEL, tamlootManifest } from './tamloot-contract.js';

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** An Anthropic Messages answer with structured output. */
const message = (output: unknown, stop_reason = 'end_turn') =>
  json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: TAMLOOT_MODEL,
    content: stop_reason === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: name,
  type,
  description: null,
  readOnly: false,
  settings: {},
  ...extra,
});
/** A workspace that calls its people contacts, its tasks actions and its meetings calls. */
const schema = {
  objects: [
    {
      nameSingular: 'call',
      labelPlural: 'Calls',
      description: 'Phone and video calls.',
      class: 'event',
      fields: [field('title', 'text', { coreRole: 'title' })],
    },
    {
      nameSingular: 'contact',
      labelPlural: 'Contacts',
      description: null,
      class: 'entity',
      fields: [field('fullName', 'full_name'), field('emailAddresses', 'emails')],
    },
    {
      nameSingular: 'action',
      labelPlural: 'Actions',
      description: 'Things to do.',
      class: 'entity',
      fields: [
        field('subject', 'text'),
        field('state', 'select', {
          settings: {
            options: [
              { value: 'idea', label: 'Idea' },
              { value: 'completed', label: 'Completed' },
            ],
          },
        }),
        field('contact', 'relation', { settings: { targetObject: 'contact' } }),
        field('deal', 'relation', { settings: { targetObject: 'deal' } }),
        field('score', 'text', { readOnly: true }),
      ],
    },
    {
      nameSingular: 'deal',
      labelPlural: 'Deals',
      description: null,
      class: 'entity',
      fields: [field('name', 'text')],
    },
  ],
};
type Answer = () => Response;
const pick = (action: string, target: string | null) => ({
  action,
  reason: `Because ${target ?? action}.`,
});
/** The answer for this workspace that every check accepts. */
const good = () => ({
  meeting: { ...pick('existing', 'call'), object: 'call' },
  task: {
    ...pick('existing', 'action'),
    object: 'action',
    fields: {
      title: { ...pick('existing', 'subject'), field: 'subject' },
      status: {
        ...pick('existing', 'state'),
        field: 'state',
        values: { open: 'idea', done: 'completed' },
      },
      person: { ...pick('existing', 'contact'), field: 'contact' },
    },
  },
  person: {
    ...pick('existing', 'contact'),
    object: 'contact',
    fields: {
      name: { ...pick('existing', 'fullName'), field: 'fullName' },
      emails: { ...pick('existing', 'emailAddresses'), field: 'emailAddresses' },
    },
  },
});

function configure(answer: Answer, options: { model?: boolean; bindings?: unknown } = {}) {
  const saved: unknown[] = [];
  const prompts: Record<string, unknown>[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (target.origin === 'https://model.test') {
      prompts.push(body);
      return answer();
    }
    expect(target.origin).toBe('https://retainer.test');
    if (target.pathname === '/v1/schema') return json(schema);
    const query = target.pathname.match(/^\/v1\/objects\/(\w+)\/query$/);
    if (query)
      return json({
        records: [{ id: 'r1', label: `A recent ${query[1]}` }],
        nextCursor: null,
      });
    if (target.pathname === '/v1/extensions/installation/runtime/suggestions') {
      saved.push(body);
      return json({ saved: true });
    }
    throw new Error(`unexpected request ${target}`);
  });
  const invocation = {
    protocolVersion: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    attempt: 1,
    installationId: 'installation',
    releaseDigest: 'd'.repeat(64),
    functionId: TAMLOOT.configure,
    input: { reason: 'install', previousVersion: null, newOutputs: [] },
    apiOrigin: 'https://retainer.test',
    runToken: 'rt',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    ...(options.model === false
      ? {}
      : { model: { origin: 'https://model.test', token: 'rt_model_fixture' } }),
    ...(options.bindings ? { bindings: options.bindings } : {}),
  } as Invocation;
  return {
    saved,
    prompts,
    transport,
    run: () => executeTamloot(invocation, new AbortController().signal, transport),
  };
}
const sent = (prompt: Record<string, unknown> | undefined) =>
  JSON.parse(((prompt?.messages ?? []) as { content: string }[])[0]?.content ?? '{}');

describe('Tamloot configure manifest', () => {
  const manifest = tamlootManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  it('declares one read-only configure function that uses the model and no secrets', () => {
    const configureFn = manifest.functions.find((fn) => fn.universalId === TAMLOOT.configure);
    expect(configureFn).toMatchObject({
      name: 'configure',
      trigger: { kind: 'configure' },
      scopes: ['read'],
      uses: ['model'],
      secrets: [],
    });
    expect(
      manifest.functions.filter((fn) => fn.uses?.includes('model')).map((fn) => fn.name),
    ).toEqual(['configure']);
  });
  it('asks for every binding and field, and never offers skip for a required one', () => {
    const schemaOut = answerSchema() as {
      required: string[];
      properties: Record<string, { properties: Record<string, { enum?: string[] }> }>;
    };
    expect(schemaOut.required).toEqual(['meeting', 'task', 'person']);
    expect(schemaOut.properties.meeting?.properties.action?.enum).toEqual(['existing', 'create']);
    expect(schemaOut.properties.task?.properties.action?.enum).toEqual([
      'existing',
      'create',
      'skip',
    ]);
    expect(schemaOut.properties.meeting?.properties.fields).toBeUndefined();
  });
});

describe('Tamloot configure (spec 3.1)', () => {
  it('sends the bindings with their candidates and saves the model’s choices', async () => {
    const c = configure(() => message(good()));
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved).toEqual([
      {
        bindings: {
          meeting: { action: 'existing', objects: ['call'] },
          task: {
            action: 'existing',
            objects: ['action'],
            fields: {
              title: { action: 'existing', field: 'subject' },
              status: {
                action: 'existing',
                field: 'state',
                values: { open: 'idea', done: 'completed' },
              },
              person: { action: 'existing', field: 'contact' },
            },
          },
          person: {
            action: 'existing',
            objects: ['contact'],
            fields: {
              name: { action: 'existing', field: 'fullName' },
              emails: { action: 'existing', field: 'emailAddresses' },
            },
          },
        },
        bindingReasons: {
          meeting: 'Because call.',
          task: 'Because action.',
          'task.title': 'Because subject.',
          'task.status': 'Because state.',
          'task.person': 'Because contact.',
          person: 'Because contact.',
          'person.name': 'Because fullName.',
          'person.emails': 'Because emailAddresses.',
        },
      },
    ]);
    const [prompt] = c.prompts;
    expect(prompt).toMatchObject({
      model: TAMLOOT_MODEL,
      output_config: { format: { type: 'json_schema', schema: answerSchema() } },
    });
    const input = sent(prompt);
    const byKey = Object.fromEntries(
      input.bindings.map((b: { key: string; candidates: { name: string }[] }) => [
        b.key,
        b.candidates.map((candidate) => candidate.name),
      ]),
    );
    // Event bindings see event types only, entity bindings entities only.
    expect(byKey).toEqual({
      meeting: ['call'],
      task: ['contact', 'action', 'deal'],
      person: ['contact', 'action', 'deal'],
    });
    const action = input.bindings[1].candidates[1];
    expect(action).toMatchObject({ label: 'Actions', recentRecords: ['A recent action'] });
    // Read-only, core and incompatible fields are never offered.
    expect(action.fields.map((f: { name: string }) => f.name)).toEqual([
      'subject',
      'state',
      'contact',
      'deal',
    ]);
    expect(action.fields[1].options).toEqual([
      { value: 'idea', label: 'Idea' },
      { value: 'completed', label: 'Completed' },
    ]);
    expect(input.bindings[0].candidates[0].fields).toEqual([]);
    expect(input.currentBindings).toBeUndefined();
  });

  it('leaves out every choice that cannot fit, so the server default applies', async () => {
    const answer = good();
    const c = configure(() =>
      message({
        // A required binding can't be skipped.
        meeting: { ...pick('skip', null), object: null },
        task: {
          ...answer.task,
          fields: {
            // Not a field of the object.
            title: { ...pick('existing', 'missing'), field: 'missing' },
            // One value maps to an option the field lacks.
            status: { ...answer.task.fields.status, values: { open: 'todo', done: 'completed' } },
            // A relation to another object than the person binding's.
            person: { ...pick('existing', 'deal'), field: 'deal' },
          },
        },
        // An entity binding can't go to an event type.
        person: { ...pick('existing', 'call'), object: 'call', fields: answer.person.fields },
      }),
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved).toEqual([
      {
        bindings: {
          task: {
            action: 'existing',
            objects: ['action'],
            fields: {
              status: { action: 'existing', field: 'state', values: { done: 'completed' } },
            },
          },
        },
        bindingReasons: { task: 'Because action.', 'task.status': 'Because state.' },
      },
    ]);
  });

  it('saves create and skip choices without fields', async () => {
    const c = configure(() =>
      message({
        meeting: { ...pick('create', null), object: null },
        task: { ...pick('skip', null), object: null, fields: good().task.fields },
        person: { ...good().person },
      }),
    );
    await c.run();
    expect(c.saved[0]).toMatchObject({
      bindings: {
        meeting: { action: 'create' },
        task: { action: 'skip' },
        person: { action: 'existing', objects: ['contact'] },
      },
    });
  });

  it('sends the current bindings on a later run', async () => {
    const c = configure(() => message(good()), {
      bindings: {
        bindings_revision: 2,
        createPeople: 'everyone',
        bindings: {
          meeting: {
            status: 'ok',
            objects: [{ id: 'x', name: 'call', label: 'Calls' }],
            fields: {},
          },
          task: null,
        },
      },
    });
    await c.run();
    expect(sent(c.prompts[0]).currentBindings).toEqual({
      meeting: { objects: ['call'], fields: {} },
      task: null,
    });
  });

  it.each([
    [
      'the proxy has no key',
      () => json({ type: 'error', error: { type: 'model_unavailable', message: 'x' } }, 503),
    ],
    ['the model refuses', () => message(null, 'refusal')],
    ['the output does not parse', () => message({ meeting: 'call' })],
    [
      'the provider is down',
      () => json({ type: 'error', error: { type: 'x', message: 'x' } }, 500),
    ],
  ])('saves nothing when %s, so the review opens with the default', async (_case, answer) => {
    const c = configure(answer);
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready_without_model' });
    expect(c.saved).toEqual([]);
  });

  it('makes no model request when the run has no model', async () => {
    const c = configure(
      () => {
        throw new Error('unexpected model request');
      },
      { model: false },
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready_without_model' });
    expect(c.prompts).toEqual([]);
  });
});
