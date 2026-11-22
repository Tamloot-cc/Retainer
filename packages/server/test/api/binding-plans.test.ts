import { randomUUID } from 'node:crypto';
import { bookingManifest } from '@retainer/runner/booking-contract';
import { expect, it } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const manifest = bookingManifest({
  version: '1.0.0',
  packageDigest: 'a'.repeat(64),
  serverRange: '>=0.1.0 <0.2.0',
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
const installation = {
  registrationId: manifest.universalId,
  version: manifest.version,
  settings: {},
};

async function setup() {
  const app = startTestApp(db, { extensionCatalog: catalog });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Booking ${randomUUID()}` },
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
        nameSingular: 'booking',
        namePlural: 'bookings',
        labelSingular: 'Booking',
        labelPlural: 'Bookings',
        labelField: 'name',
        fields: [{ name: 'name', type: 'text', label: 'Name' }],
      },
    },
  ]);
  expect(clash.status).toBe(200);
  const reviewed = await h.preview();
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  expect(reviewed.body.bindings.booking).toMatchObject({
    action: 'create',
    nameSingular: 'bookingBooking',
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
  const booking = bindings.body.bindings.booking;
  const [object] = booking.objects;
  const stamp = {
    bindings_revision: bindings.body.bindings_revision,
    objectId: object.id,
    fieldIds: Object.fromEntries(
      Object.values<{ name: string; id: string }>(booking.fields).map((field) => [
        field.name,
        field.id,
      ]),
    ),
  };
  const created = await h.app.request(`/v1/objects/${object.name}/records`, {
    key,
    body: {
      values: { bookingId: 'test-booking', title: 'Consultation', status: 'confirmed' },
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
    body: { values: { emails: 'booking@example.test' } },
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
  ).toContain('Booking');
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
    expect(removed.body.error.details.issues[0].message).toContain('Booking');
  } else {
    expect(approved.status).toBe(409);
    expect(removed.status).toBe(200);
  }
});
