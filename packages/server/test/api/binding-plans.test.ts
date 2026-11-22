import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const manifest = extensionFixture({
  name: 'dispatch',
  execution: 'standalone',
  scopes: ['read', 'write'],
  bindings: [
    {
      key: 'ticket',
      label: 'Tickets',
      description: 'Dispatch status for each ticket.',
      class: 'entity',
      access: 'write',
      required: true,
      owned: true,
      creates: true,
      create: {
        universalId: randomUUID(),
        nameSingular: 'ticket',
        namePlural: 'tickets',
        labelSingular: 'Ticket',
        labelPlural: 'Tickets',
        labelField: 'status',
        fields: [],
      },
      fields: [
        {
          key: 'status',
          label: 'Status',
          types: ['text'],
          required: true,
          installationOnly: true,
          create: { universalId: randomUUID(), name: 'status', label: 'Status', type: 'text' },
        },
        {
          key: 'person',
          label: 'Person',
          types: ['relation'],
          required: false,
          lookup: true,
          target: 'person',
          create: { universalId: randomUUID(), name: 'person', label: 'Person', type: 'relation' },
        },
      ],
    },
    {
      key: 'person',
      label: 'People',
      description: 'Optional contact target.',
      class: 'entity',
      access: 'read',
      required: false,
      fields: [],
    },
  ],
});
const contacts = extensionFixture({
  name: 'contacts',
  createPeople: 'everyone',
  bindings: [
    {
      key: 'contacts',
      label: 'Contacts',
      description: 'Contacts created by the extension.',
      class: 'entity',
      access: 'write',
      required: true,
      creates: true,
      match: 'addresses',
      fields: [{ key: 'addresses', label: 'Addresses', types: ['emails'], required: true }],
    },
  ],
});
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration' },
  { manifest: contacts, actorCeiling: 'integration' },
]);
const installation = {
  registrationId: manifest.universalId,
  version: manifest.version,
  settings: {},
};

async function setup() {
  const app = startTestApp(db, { extensionCatalog: catalog });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Dispatch ${randomUUID()}` },
    {
      admin: {
        actor: { type: 'user', id: 'admin' },
        scopes: ['admin', 'read', 'write', 'schema:write'],
      },
      agent: { actor: { type: 'agent', id: 'setup' }, scopes: ['read', 'schema:write'] },
    },
  );
  const key = keys.admin;
  const change = (operations: unknown[]) =>
    app.request('/v1/schema/changes', { key, body: { operations } });
  const preview = (body = installation) => app.request('/v1/extensions/preview', { key, body });
  const commit = (planDigest: string, input = installation) =>
    app.request('/v1/extensions', {
      key,
      headers: { 'idempotency-key': randomUUID() },
      body: { ...input, planDigest },
    });
  return { app, key, keys, workspace, change, preview, commit };
}

it('creates a prefixed owned object, guards the plan, and fences standalone writes after rename', async () => {
  const h = await setup();
  const clash = await h.change([
    {
      op: 'create_object',
      object: {
        nameSingular: 'ticket',
        namePlural: 'tickets',
        labelSingular: 'Ticket',
        labelPlural: 'Tickets',
        labelField: 'name',
        fields: [{ name: 'name', type: 'text', label: 'Name' }],
      },
    },
  ]);
  expect(clash.status).toBe(200);
  const reviewed = await h.preview();
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  expect(reviewed.body.bindings.ticket).toMatchObject({
    action: 'create',
    nameSingular: 'dispatchTicket',
  });
  const results = await Promise.all([
    h.commit(reviewed.body.planDigest),
    h.commit(reviewed.body.planDigest),
  ]);
  expect(results.map((row) => row.status).sort()).toEqual([201, 409]);
  const installed = results.find((row) => row.status === 201)?.body;
  const base = `/v1/extensions/${installed.id}`;
  expect((await h.app.request(`${base}/bindings`, { key: h.key })).status).toBe(404);
  const grant = await h.app.request(`${base}/keys`, {
    key: h.key,
    body: { expectedGeneration: installed.generation, scopes: ['read', 'write'] },
  });
  expect(grant.status, JSON.stringify(grant.body.error ?? null)).toBe(201);
  const key = grant.body.key as string;
  const bindings = await h.app.request(`${base}/bindings`, { key });
  expect(bindings.status).toBe(200);
  const ticket = bindings.body.bindings.ticket;
  const [object] = ticket.objects;
  const stamp = {
    bindings_revision: bindings.body.bindings_revision,
    objectId: object.id,
    fieldIds: Object.fromEntries(
      Object.values<{ name: string; id: string }>(ticket.fields).map((field) => [
        field.name,
        field.id,
      ]),
    ),
  };
  const created = await h.app.request(`/v1/objects/${object.name}/records`, {
    key,
    body: {
      values: { status: 'confirmed' },
      bindings: stamp,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const record = `/v1/records/${created.body.id}`;
  expect(
    (
      await h.app.request(record, {
        key: h.key,
        method: 'PATCH',
        body: { values: { status: 'cancelled' } },
      })
    ).body.error.code,
  ).toBe('installation_owned');
  const person = await h.app.request('/v1/objects/person/records', {
    key: h.key,
    body: { values: { emails: 'ticket@example.test' } },
  });
  expect(person.status).toBe(201);
  expect(
    (
      await h.app.request(record, {
        key: h.key,
        method: 'PATCH',
        body: { values: { person: person.body.id } },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.change([
        {
          op: 'create_field',
          object: object.name,
          field: { name: 'timezone', label: 'Time zone', type: 'text', isNullable: false },
        },
      ])
    ).body.error.details.issues[0].message,
  ).toContain('Dispatch');
  const renamed = await h.change([
    { op: 'rename_field', object: object.name, field: 'status', name: 'state' },
  ]);
  expect(renamed.status).toBe(200);
  expect(
    (
      await h.change([
        {
          op: 'create_field',
          object: object.name,
          field: { name: 'status', label: 'Other status', type: 'text' },
        },
      ])
    ).status,
  ).toBe(200);
  const stale = await h.app.request(record, {
    key,
    method: 'PATCH',
    body: {
      bindings: stamp,
      values: { status: 'cancelled' },
    },
  });
  expect(stale.body.error.code).toBe('binding_unavailable');
});

it('serializes approval against deleting a prepared destination', async () => {
  const h = await setup();
  const reviewed = await h.preview();
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  const [approved, removed] = await Promise.all([
    h.commit(reviewed.body.planDigest),
    h.change([{ op: 'delete_object', object: 'person' }]),
  ]);
  if (approved.status === 201) {
    expect(removed.status).toBe(422);
    expect(removed.body.error.details.issues[0].message).toContain('Dispatch');
  } else {
    expect(approved.status).toBe(409);
    expect(removed.status).toBe(200);
  }
});

it('prefills a validated agent proposal for a human admin without changing the schema', async () => {
  const h = await setup();
  const input = { ...installation, bindings: { person: { action: 'skip' } } };
  const agent = await h.app.mcpClient(h.keys.agent);
  try {
    const proposal = await agent.call('preview_extension', input);
    expect(proposal.isError, JSON.stringify(proposal.body)).toBe(false);
    expect(proposal.body.bindings.person).toEqual({ action: 'skip' });
  } finally {
    await agent.close();
  }
  const { body: catalog } = await h.app.request('/v1/extensions/catalog', { key: h.key });
  expect(catalog.releases[0]?.bindingProposal).toMatchObject({
    choices: input.bindings,
    proposedBy: { type: 'agent', id: 'setup' },
  });
  const publicCatalog = await h.app.request('/v1/extensions/catalog', { key: h.keys.agent });
  expect(publicCatalog.body.releases[0]?.bindingProposal).toBeUndefined();
  expect((await h.app.request('/v1/extensions', { key: h.key })).body.installations).toEqual([]);
  expect((await h.app.request('/v1/schema', { key: h.key })).body.objects).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ nameSingular: 'ticket' })]),
  );
  const review = await h.preview();
  expect(review.body.bindings.person).toEqual({ action: 'skip' });
  expect((await h.commit(review.body.planDigest)).status).toBe(201);
});

it('releases an uninstalled object and replaces its deleted contribution with fresh IDs', async () => {
  const h = await setup();
  const first = await h.preview();
  const installed = await h.commit(first.body.planDigest);
  expect(installed.status).toBe(201);
  const id = installed.body.id;
  const details = async () => (await h.app.request(`/v1/extensions/${id}`, { key: h.key })).body;
  const original = (await details()).contributions.find(
    (entry: { kind: string }) => entry.kind === 'object',
  );
  const uninstall = await h.app.request(`/v1/extensions/${id}/uninstall`, {
    key: h.key,
    method: 'POST',
  });
  expect(uninstall.body.state).toBe('uninstalled');
  expect((await h.change([{ op: 'delete_object', object: 'ticket' }])).status).toBe(200);
  const next = await h.preview();
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  expect((await h.commit(next.body.planDigest)).status).toBe(201);
  const objects = (await details()).contributions.filter(
    (entry: { kind: string }) => entry.kind === 'object',
  );
  expect(objects).toHaveLength(1);
  expect(objects[0].elementId).not.toBe(original.elementId);
  expect(objects[0].universalId).not.toBe(original.universalId);
});

it('names duplicate records before asking the admin to approve a unique match field', async () => {
  const h = await setup();
  expect(
    (
      await h.change([
        {
          op: 'create_object',
          object: {
            nameSingular: 'customer',
            namePlural: 'customers',
            labelSingular: 'Customer',
            labelPlural: 'Customers',
            labelField: 'name',
            fields: [
              { name: 'name', label: 'Name', type: 'text' },
              { name: 'addresses', label: 'Addresses', type: 'emails' },
            ],
          },
        },
      ])
    ).status,
  ).toBe(200);
  for (const name of ['First customer', 'Second customer']) {
    expect(
      (
        await h.app.request('/v1/objects/customer/records', {
          key: h.key,
          body: { values: { name, addresses: 'shared@example.test' } },
        })
      ).status,
    ).toBe(201);
  }
  const review = await h.app.request('/v1/extensions/preview', {
    key: h.key,
    body: {
      registrationId: contacts.universalId,
      version: contacts.version,
      settings: {},
      bindings: { contacts: { action: 'existing', objects: ['customer'] } },
    },
  });
  expect(review.status, JSON.stringify(review.body)).toBe(422);
  expect(review.body.error.code).toBe('bindings_invalid');
  expect(review.body.error.message).toContain('First customer, Second customer');
});
