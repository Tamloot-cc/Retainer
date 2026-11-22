import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import type { Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { runSchemaChange, SYSTEM_ACTOR } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { BASE_EVENT_OPERATIONS, BASE_OPERATIONS } from '../../src/templates/index.js';
import { definitionsFor, upgradeWorkspaces } from '../../src/workspaces/upgrade.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { addNoteType } from '../helpers/note-type.js';

const db = useTestDatabase();
let api: TestApp;
let owner: Sql;

beforeAll(async () => {
  api = startTestApp(db);
  owner = db.owner;
  await owner`insert into organizations (name) values ('Default')`;
});

/**
 * A workspace as releases before event types created it: the base entity
 * objects only. Protection did not exist yet either; the fixture clears it,
 * as migration 0012 left it on those rows.
 */
async function legacyWorkspace(slug: string, extra: SchemaOperation[] = []) {
  const [row] = await owner<{ id: string }[]>`
    insert into workspaces (organization_id, slug, name)
    values ((select id from organizations order by created_at limit 1), ${slug}, ${slug})
    returning id`;
  const workspaceId = row?.id as string;
  await inWorkspace(owner, workspaceId, async (tx) => {
    await runSchemaChange(tx, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: [],
      operations: BASE_OPERATIONS,
      owner: 'system',
      trusted: true,
    });
    if (extra.length > 0) {
      await runSchemaChange(tx, {
        workspaceId,
        actor: { type: 'agent', id: 'bot' },
        scopes: ['schema:write'],
        operations: extra,
      });
    }
  });
  await owner`update object_types set is_protected = false where workspace_id = ${workspaceId}`;

  const { key } = await createApiKey(owner, {
    workspace: workspaceId,
    name: 'admin',
    actor: { type: 'user', id: 'dana' },
    scopes: ['read', 'write', 'schema:write', 'admin'],
  });
  return { workspaceId, key };
}

const logCall = (key: string, extra: Record<string, unknown> = {}) =>
  api.request('/v1/events', {
    key,
    body: {
      type: 'conversation',
      channel: 'phone',
      occurredAt: '2026-11-01T09:00:00Z',
      title: 'Intro call',
      ...extra,
    },
  });

const changesOf = (workspaceId: string) =>
  owner<{ requested_by: { type: string; id: string }; reason: string; status: string }[]>`
    select requested_by, reason, status from schema_changes
    where workspace_id = ${workspaceId} and reason = 'Upgrade internal definitions'`;

const digestOf = async (workspaceId: string) =>
  (
    await owner<{ definitions_digest: string | null }[]>`
      select definitions_digest from workspaces where id = ${workspaceId}`
  )[0]?.definitions_digest;

describe('upgrading workspaces to the internal definitions', () => {
  it('leaves an existing note type and its events, which an admin can then delete (C5)', async () => {
    const { workspaceId, key } = await legacyWorkspace('kept-notes');
    await addNoteType(owner, workspaceId);
    const admin = (
      await createApiKey(owner, {
        workspace: workspaceId,
        name: 'admin',
        actor: { type: 'user', id: 'ops' },
        scopes: ['admin'],
      })
    ).key;
    await upgradeWorkspaces(owner);
    const eventTypes = async () =>
      (await api.request('/v1/schema', { key })).body.objects
        .filter((o: { class: string }) => o.class === 'event')
        .map((o: { nameSingular: string }) => o.nameSingular);
    expect(await eventTypes()).toEqual(['note']);
    const note = await logCall(key, { type: 'note' });
    expect(note.status).toBe(201);
    expect((await upgradeWorkspaces(owner)).failed).toEqual([]);
    expect((await api.request(`/v1/events/${note.body.id}`, { key })).status).toBe(200);

    const proposed = await api.request('/v1/schema/changes', {
      key: admin,
      body: { operations: [{ op: 'delete_object', object: 'note' }] },
    });
    expect(['applied', 'proposed']).toContain(proposed.body.status);
    if (proposed.body.status === 'proposed') {
      const approved = await api.request(`/v1/schema/changes/${proposed.body.change.id}/approve`, {
        key: admin,
        method: 'POST',
      });
      expect(approved.body.status).toBe('applied');
    }
    expect(await eventTypes()).toEqual([]);
    // The upgrade never brings it back.
    await owner`update workspaces set definitions_digest = null where id = ${workspaceId}`;
    await upgradeWorkspaces(owner);
    expect(await eventTypes()).toEqual([]);
  });

  it('logs how many about links to events a workspace has, and leaves them (C4)', async () => {
    const { workspaceId, key } = await legacyWorkspace('linked-events', BASE_EVENT_OPERATIONS);
    await upgradeWorkspaces(owner);
    const a = await logCall(key);
    const b = await logCall(key);
    await owner`
      insert into event_links (workspace_id, event_id, position, record_id, link)
      values (${workspaceId}, ${b.body.id}, 0, ${a.body.id}, 'about')`;
    await owner`update workspaces set definitions_digest = null where id = ${workspaceId}`;
    const report = await upgradeWorkspaces(owner);
    expect(report.aboutEventLinks).toEqual([{ workspace: 'linked-events', count: 1 }]);
    const read = await api.request(`/v1/events/${b.body.id}`, { key });
    expect(read.body.event.about).toEqual([a.body.id]);
  });

  it('adds hidden types to an older workspace without changing its visible schema', async () => {
    const { workspaceId, key } = await legacyWorkspace('legacy');
    const before = await logCall(key);
    expect(before.status).toBe(404);

    const report = await upgradeWorkspaces(owner);
    expect(report).toEqual({
      upgraded: ['legacy'],
      conflicts: [],
      failed: [],
      aboutEventLinks: [],
    });

    const schema = await api.request('/v1/schema', { key });
    const objects = schema.body.objects as {
      nameSingular: string;
      class: string;
      isProtected: boolean;
    }[];
    expect(objects.filter((o) => o.class === 'event')).toEqual([]);
    expect(objects.filter((o) => o.isProtected)).toEqual([]);

    const person = await api.request('/v1/objects/person/records', {
      key,
      body: { values: { name: 'Noa Levi', emails: 'noa@example.com' } },
    });
    expect(person.status).toBe(201);
    // remember without a source writes an internal note.
    const fact = await api.request(`/v1/records/${person.body.id}/facts`, {
      key,
      body: { text: 'Prefers calls in the morning.' },
    });
    expect(fact.status).toBe(201);

    expect(await changesOf(workspaceId)).toEqual([
      {
        requested_by: SYSTEM_ACTOR,
        reason: 'Upgrade internal definitions',
        status: 'applied',
      },
    ]);
    expect(await digestOf(workspaceId)).toBe(definitionsFor().digest);
  });

  it('changes nothing on a second run, and stamps a current workspace without a change', async () => {
    const { workspace } = await api.setupWorkspace({ name: 'Fresh', template: 'clinic' }, {});
    expect(await upgradeWorkspaces(owner)).toEqual({
      upgraded: [],
      conflicts: [],
      failed: [],
      aboutEventLinks: [],
    });
    expect(await changesOf(workspace.id)).toEqual([]);
    expect(await digestOf(workspace.id)).toBe(definitionsFor().digest);
    expect(await upgradeWorkspaces(owner)).toEqual({
      upgraded: [],
      conflicts: [],
      failed: [],
      aboutEventLinks: [],
    });
  });

  it('upgrades each workspace once when two runs race', async () => {
    const { workspaceId } = await legacyWorkspace('raced');
    const [a, b] = await Promise.all([
      upgradeWorkspaces(db.connect({ max: 1 })),
      upgradeWorkspaces(db.connect({ max: 1 })),
    ]);
    expect([...a.upgraded, ...b.upgraded]).toEqual(['raced']);
    expect([...a.failed, ...b.failed]).toEqual([]);
    expect(await changesOf(workspaceId)).toHaveLength(1);
  });

  it('upgrades a workspace whose schema has an issue an older release allowed', async () => {
    const visit: SchemaOperation = {
      op: 'create_object',
      object: {
        nameSingular: 'visit',
        namePlural: 'visits',
        labelSingular: 'Visit',
        labelPlural: 'Visits',
        labelField: 'name',
        fields: [{ name: 'name', label: 'Name', type: 'text' }],
      },
    };
    const { workspaceId, key } = await legacyWorkspace('tolerated', [visit]);
    // Before "interaction" was reserved, a workspace could name its own object so.
    await owner`
      update object_types set name_singular = 'interaction', name_plural = 'interactions'
      where workspace_id = ${workspaceId} and name_singular = 'visit'`;

    expect(await upgradeWorkspaces(owner)).toEqual({
      upgraded: ['tolerated'],
      conflicts: [],
      failed: [],
      aboutEventLinks: [],
    });
    expect((await logCall(key)).status).toBe(404);
    expect(await digestOf(workspaceId)).toBe(definitionsFor().digest);
    // Changes outside the trusted path still refuse the old issue.
    const change = await api.request('/v1/schema/changes', {
      key,
      body: {
        reason: 'test',
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: { name: 'size', label: 'Size', type: 'number' },
          },
        ],
      },
    });
    expect(change.status, JSON.stringify(change.body)).toBe(422);
    expect(JSON.stringify(change.body)).toContain('reserved');
  });

  it('leaves empty and templated workspaces unchanged on upgrade', async () => {
    const empty = await createWorkspace(owner, { name: 'Empty upgrade' });
    const templated = await createWorkspace(owner, { name: 'Template upgrade', template: 'sales' });
    const ids = [empty.id, templated.id];
    const readTypes = () => owner`
      select workspace_id, id, name_singular from object_types
      where workspace_id = any(${ids}::uuid[]) order by id`;
    const before = await readTypes();
    await owner`update workspaces set definitions_digest = null where id = any(${ids}::uuid[])`;
    expect(await upgradeWorkspaces(owner)).toMatchObject({ upgraded: [], failed: [] });
    expect(await readTypes()).toEqual(before);
    expect(await digestOf(empty.id)).toBe(definitionsFor().digest);
    expect(await digestOf(templated.id)).toBe(definitionsFor().digest);
  });
});
