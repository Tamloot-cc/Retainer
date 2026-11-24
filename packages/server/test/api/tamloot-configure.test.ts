import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { executeTamloot } from '@retainer/runner/tamloot';
import { TAMLOOT, tamlootManifest } from '@retainer/runner/tamloot-contract';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { answer, fakeAnthropic, type Received, type Upstream } from '../helpers/model.js';

const db = useTestDatabase();
let tokens: RunTokens, upstream: Upstream;
beforeAll(async () => {
  upstream = await fakeAnthropic();
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'tamloot-configure',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});

/** Answers a Messages request with structured output, as the model would. */
const structured = (output: unknown) => (request: Received, res: ServerResponse) =>
  answer(request, res, 'claude-haiku-5-5', {
    text: JSON.stringify(output),
    stopReason: 'end_turn',
  });
const why = (text: string) => ({ reason: text });

/** A workspace that calls its meetings calls, its people contacts and its tasks actions. */
async function setup(modelKey = true) {
  const manifest = tamlootManifest({
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    }),
    catalog = new ExtensionCatalog([
      { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ]);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    model: { apiKey: modelKey ? 'sk-model-fixture' : undefined, upstream: upstream.origin },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Tamloot configure ${randomUUID()}`, template: null },
    {
      admin: {
        actor: { type: 'user', id: 'admin', name: 'Admin' },
        scopes: ['admin', 'read', 'write', 'schema:write'],
      },
    },
  );
  const schema = await app.request('/v1/schema/changes', {
    key: keys.admin,
    body: {
      reason: 'Our CRM',
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'call',
            namePlural: 'calls',
            labelSingular: 'Call',
            labelPlural: 'Calls',
            fields: [],
          },
        },
        {
          op: 'create_object',
          object: {
            nameSingular: 'contact',
            namePlural: 'contacts',
            labelSingular: 'Contact',
            labelPlural: 'Contacts',
            labelField: 'name',
            fields: [
              { name: 'name', label: 'Name', type: 'text' },
              { name: 'emailAddresses', label: 'Email addresses', type: 'emails' },
              // A text field named like Tamloot's new `emails` field, which the model never sees.
              { name: 'emails', label: 'Old emails', type: 'text' },
            ],
          },
        },
        {
          op: 'create_object',
          object: {
            nameSingular: 'action',
            namePlural: 'actions',
            labelSingular: 'Action',
            labelPlural: 'Actions',
            labelField: 'subject',
            fields: [
              { name: 'subject', label: 'Subject', type: 'text' },
              {
                name: 'state',
                label: 'State',
                type: 'select',
                settings: {
                  options: [
                    { value: 'idea', label: 'Idea' },
                    { value: 'completed', label: 'Completed' },
                  ],
                },
              },
              {
                name: 'contact',
                label: 'Contact',
                type: 'relation',
                settings: { targetObject: 'contact' },
              },
            ],
          },
        },
      ],
    },
  });
  expect(schema.body.status, JSON.stringify(schema.body)).toBe('applied');
  const recorded = await app.request('/v1/objects/action/records', {
    key: keys.admin,
    body: { values: { subject: 'Send the pricing deck', state: 'idea' } },
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

  // Step one: approve access, which queues `configure`.
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings: { shareMeetings: true, createPeople: 'everyone' },
  };
  const access = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  expect(access.body.grants.uses).toEqual(['model']);
  expect(access.body.notices).toEqual([
    'To suggest where your meetings, tasks, and contacts should go, Tamloot sends Anthropic your workspace structure, any existing mappings, and the names or titles of up to three recently updated records per possible destination. Tamloot uses Anthropic only for these suggestions.',
    'You’ll review the suggestions before applying any changes to your workspace.',
  ]);
  const configuring = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: access.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(configuring.status, JSON.stringify(configuring.body)).toBe(201);
  const id = configuring.body.id as string;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);

  /** Runs the queued `configure` job through the bundle, the API and the model proxy. */
  async function configure() {
    const [queued] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where installation_id=${id} and trigger_kind='configure' and status='queued'`;
    if (!queued) throw new Error('configure not queued');
    const job = await queue.claim(workspace.id, queued.id, `worker-${randomUUID()}`);
    if (!job) throw new Error('configure missing');
    expect(job.functionId).toBe(TAMLOOT.configure);
    expect(job.scopes).toEqual(['read']);
    const model = job.uses.includes('model')
      ? {
          origin: 'https://retainer.test/v1/extensions/runtime/model',
          token: await tokens.issueModel(job),
        }
      : undefined;
    const result = await executeTamloot(
      {
        protocolVersion: 1,
        runId: job.jobId,
        attempt: job.attempt,
        installationId: id,
        releaseDigest: job.releaseDigest,
        functionId: job.functionId,
        input: job.input as never,
        apiOrigin: 'https://retainer.test',
        runToken: await tokens.issue(app.sql, job, manifest.universalId, job.scopes),
        deadline: job.deadline.toISOString(),
        ...(model ? { model } : {}),
      },
      new AbortController().signal,
      (url, init) => app.inProcessFetch(url, init),
    );
    await queue.complete(job, result);
    return result;
  }
  /** Step two's preview: the review form, before the admin changes anything. */
  const review = () =>
    app.request('/v1/extensions/preview', {
      key: keys.admin,
      body: { ...input, installationId: id, turnOn: true },
    });
  return { app, keys, id, configure, review };
}

describe('Tamloot configure through the real API, Postgres and model proxy', () => {
  it('suggests bindings with the model, and the review opens with them', async () => {
    const h = await setup();
    upstream.respond(
      structured({
        meeting: { action: 'existing', object: 'call', ...why('Calls hold meetings.') },
        task: {
          action: 'existing',
          object: 'action',
          ...why('Actions are to-dos.'),
          fields: {
            title: { action: 'existing', field: 'subject', ...why('The subject is the title.') },
            status: {
              action: 'existing',
              field: 'state',
              values: { open: 'idea', done: 'completed' },
              ...why('Idea is open; completed is done.'),
            },
            person: { action: 'existing', field: 'contact', ...why('It names the contact.') },
          },
        },
        person: {
          action: 'existing',
          object: 'contact',
          ...why('Contacts are people.'),
          fields: {
            name: { action: 'existing', field: 'name', ...why('Same meaning.') },
            emails: { action: 'existing', field: 'emailAddresses', ...why('Same meaning.') },
          },
        },
      }),
    );
    const before = upstream.received.length;
    expect(await h.configure()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });

    // The model saw this workspace's objects and a record label, through the proxy.
    const [sent] = upstream.received.slice(before).filter((r) => r.url === '/v1/messages');
    expect(sent?.headers['x-api-key']).toBe('sk-model-fixture');
    const prompt = JSON.parse(JSON.parse(sent?.body ?? '{}').messages[0].content);
    const task = prompt.bindings.find((b: { key: string }) => b.key === 'task');
    expect(task.candidates.find((c: { name: string }) => c.name === 'action')).toMatchObject({
      recentRecords: ['Send the pricing deck'],
    });

    const saved = await h.app.request(`/v1/extensions/${h.id}/suggestions`, {
      key: h.keys.admin,
    });
    expect(saved.body.status).toBe('ready');
    expect(saved.body.bindingReasons).toMatchObject({
      meeting: 'Calls hold meetings.',
      'task.status': 'Idea is open; completed is done.',
    });

    const preview = await h.review();
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.bindings).toMatchObject({
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
      person: { action: 'existing', objects: ['contact'] },
    });
    // No new objects: everything goes to the workspace's own.
    expect(
      preview.body.operations.filter((op: { op: string }) => op.op === 'create_object'),
    ).toEqual([]);
  });

  it('drops each suggestion the review would reject, so the default applies there', async () => {
    const h = await setup();
    upstream.respond(
      structured({
        meeting: { action: 'existing', object: 'call', ...why('Calls hold meetings.') },
        task: {
          action: 'existing',
          object: 'action',
          ...why('Actions are to-dos.'),
          fields: {
            title: { action: 'existing', field: 'subject', ...why('The subject is the title.') },
            // `contacts` is many-to-many (added below), which a Tamloot task can't use.
            person: { action: 'existing', field: 'contacts', ...why('It names the contacts.') },
            status: {
              action: 'existing',
              field: 'state',
              values: { open: 'idea', done: 'completed' },
              ...why('Idea is open; completed is done.'),
            },
          },
        },
        person: {
          action: 'existing',
          object: 'contact',
          ...why('Contacts are people.'),
          fields: {
            name: { action: 'existing', field: 'name', ...why('Same meaning.') },
            // A new `emails` field clashes with the contact's text field of that name.
            emails: { action: 'create', field: '', ...why('No email field fits.') },
          },
        },
      }),
    );
    const many = await h.app.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        reason: 'Actions name several contacts',
        operations: [
          {
            op: 'create_field',
            object: 'action',
            field: {
              name: 'contacts',
              label: 'Contacts',
              type: 'relation',
              settings: { targetObject: 'contact', relationCardinality: 'many_to_many' },
            },
          },
        ],
      },
    });
    expect(many.body.status, JSON.stringify(many.body)).toBe('applied');
    expect(await h.configure()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });

    const saved = await h.app.request(`/v1/extensions/${h.id}/suggestions`, {
      key: h.keys.admin,
    });
    // The clash drops People's choice; the many-to-many relation drops only that field.
    expect(saved.body.issues).toEqual({});
    expect(saved.body.bindings.person).toBeUndefined();
    expect(saved.body.bindings.task).toMatchObject({ action: 'existing', objects: ['action'] });
    expect(saved.body.bindings.task.fields.person).toBeUndefined();
    expect(saved.body.bindings.task.fields.title).toEqual({ action: 'existing', field: 'subject' });
    expect(Object.keys(saved.body.bindingReasons).sort()).toEqual([
      'meeting',
      'task',
      'task.status',
      'task.title',
    ]);
    const preview = await h.review();
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  });

  it('opens the review with the fixed default when the server has no model key', async () => {
    const h = await setup(false);
    expect(await h.configure()).toEqual({
      status: 'succeeded',
      code: 'suggestions_ready_without_model',
    });
    const preview = await h.review();
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    // Without the model, no name matches "meeting", so the default creates one.
    expect(preview.body.bindings.meeting).toMatchObject({ action: 'create' });
  });
});
