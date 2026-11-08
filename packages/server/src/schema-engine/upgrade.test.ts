import { BASE_EVENT_TYPE_IDS, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import type { SchemaState } from '../schema/types.js';
import { SEED_OPERATIONS } from '../templates/base.js';
import { BASE_OBJECT_IDS, BASE_OPERATIONS, TEMPLATES } from '../templates/index.js';
import { definitionsFor } from '../workspaces/upgrade.js';
import { applyOperations } from './apply.js';
import { classifyOp, diffSchemas } from './diff.js';
import type { FieldDefinitionInput, ObjectDefinitionInput, SchemaOperation } from './operations.js';
import { applyProtection } from './protection.js';
import { planUpgrade } from './upgrade.js';
import { validateSchema } from './validate.js';

const EMPTY: SchemaState = { objects: [] };

function applyValid(
  state: SchemaState,
  operations: SchemaOperation[],
  owner: 'agent' | 'system' = 'system',
) {
  const { state: desired, issues } = applyOperations(state, operations, { owner });
  expect([...issues, ...validateSchema(desired)]).toEqual([]);
  return desired;
}

/** A workspace as created before event types existed: base entity objects only. */
const legacy = applyValid(EMPTY, BASE_OPERATIONS);
const seeded = applyValid(EMPTY, SEED_OPERATIONS);
const clinic = TEMPLATES.clinic.operations;
const realEstate = TEMPLATES.real_estate.operations;

const created = (operations: SchemaOperation[]) =>
  operations.map((o) =>
    o.op === 'create_object'
      ? o.object.nameSingular
      : o.op === 'create_field'
        ? `${o.object}.${o.field.name}`
        : o.op,
  );
const upgrade = (state: SchemaState, definitions: SchemaOperation[]) => {
  const plan = planUpgrade(state, definitions);
  return { ...plan, upgraded: applyValid(state, plan.operations) };
};
/**
 * A template as an older release defined it: `objectName` without the field
 * `pick` chooses.
 */
function withoutField(
  operations: SchemaOperation[],
  objectName: string,
  pick: (field: FieldDefinitionInput, object: ObjectDefinitionInput) => boolean,
) {
  const create = operations.find(
    (o): o is Extract<SchemaOperation, { op: 'create_object' }> =>
      o.op === 'create_object' && o.object.nameSingular === objectName,
  );
  const field = create?.object.fields.find((f) => pick(f, create.object));
  if (!create || !field) throw new Error(`no ${objectName} field to leave out`);
  const object = { ...create.object, fields: create.object.fields.filter((f) => f !== field) };
  return {
    older: operations.map((o) => (o === create ? { ...create, object } : o)),
    object: create.object,
    field,
  };
}
const objectOf = (state: SchemaState, universalId: string) =>
  state.objects.find((o) => o.universalId === universalId);
const named = (state: SchemaState, name: string) =>
  state.objects.find((o) => o.nameSingular === name && o.status === 'active');

describe('planUpgrade', () => {
  it('adds the event types, the internal-note type and the profile types a pre-events workspace lacks', () => {
    const { operations, conflicts, upgraded } = upgrade(legacy, SEED_OPERATIONS);
    expect(conflicts).toEqual([]);
    expect(created(operations)).toEqual([
      'conversation',
      'internalNote',
      'workspaceProfile',
      'memberProfile',
    ]);
    expect(upgraded.objects.filter((o) => o.class === 'event').map((o) => o.universalId)).toEqual([
      BASE_EVENT_TYPE_IDS.conversation,
      INTERNAL_NOTE_TYPE_ID,
    ]);
    // Core fields get the IDs a new workspace gets.
    const ids = (state: SchemaState) =>
      objectOf(state, BASE_EVENT_TYPE_IDS.conversation)?.fields.map((f) => f.universalId);
    expect(ids(upgraded)).toEqual(ids(seeded));
    expect(objectOf(upgraded, BASE_EVENT_TYPE_IDS.conversation)?.fields.map((f) => f.name)).toEqual(
      ['title', 'summary', 'medium'],
    );
  });

  it('gives a workspace seeded with the old event types a conversation, and keeps the old types', () => {
    const meeting = (name: string, universalId: string): SchemaOperation => ({
      op: 'create_object',
      object: {
        universalId,
        class: 'event',
        nameSingular: name,
        namePlural: `${name}s`,
        labelSingular: name,
        labelPlural: `${name}s`,
        fields: [],
      },
    });
    const old = applyValid(
      seeded,
      [
        { op: 'delete_object', object: 'conversation' },
        meeting('meeting', 'f3d0b7a2-58c1-4a8e-9d2f-6b1e0c7a4d31'),
        meeting('call', '2b9e4f61-07d3-4c5a-8e1b-93f2a6d8c045'),
      ],
      'system',
    );
    // A deleted conversation stays deleted; a workspace that never had one gets it.
    expect(created(upgrade(old, SEED_OPERATIONS).operations)).toEqual([]);
    const never = {
      ...old,
      objects: old.objects.filter((o) => o.universalId !== BASE_EVENT_TYPE_IDS.conversation),
    };
    const { operations, conflicts, upgraded } = upgrade(never, SEED_OPERATIONS);
    expect(conflicts).toEqual([]);
    expect(created(operations)).toEqual(['conversation']);
    expect(
      upgraded.objects
        .filter((o) => o.class === 'event' && o.status === 'active')
        .map((o) => o.nameSingular),
    ).toEqual(expect.arrayContaining(['meeting', 'call', 'conversation']));
  });

  it('plans nothing for a workspace that is up to date', () => {
    expect(planUpgrade(seeded, SEED_OPERATIONS)).toEqual({ operations: [], conflicts: [] });
    const withTemplate = applyValid(seeded, realEstate);
    expect(planUpgrade(withTemplate, [...SEED_OPERATIONS, ...realEstate])).toEqual({
      operations: [],
      conflicts: [],
    });
  });

  it('matches a renamed base object by universal ID and resolves relations to it', () => {
    const renamed = applyValid(legacy, [
      { op: 'rename_object', object: 'person', nameSingular: 'contact', namePlural: 'contacts' },
    ]);
    const { operations, conflicts, upgraded } = upgrade(renamed, [...SEED_OPERATIONS, ...clinic]);
    expect(conflicts).toEqual([]);
    expect(created(operations)).not.toContain('person');
    // The clinic's appointment points at the renamed object; its person fields land on it.
    const contact = objectOf(upgraded, BASE_OBJECT_IDS.person);
    expect(contact?.nameSingular).toBe('contact');
    const appointment = named(upgraded, 'appointment');
    const relation = appointment?.fields.find((f) => f.type === 'relation');
    expect(relation?.settings.targetObjectId).toBe(BASE_OBJECT_IDS.person);
    expect(contact?.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['dateOfBirth', 'appointments']),
    );
  });

  it('does not re-create a base event type or template object the workspace deleted', () => {
    const withTemplate = applyValid(seeded, clinic);
    const deleted = applyValid(withTemplate, [
      { op: 'delete_object', object: 'conversation' },
      { op: 'delete_object', object: 'appointment' },
    ]);
    expect(planUpgrade(deleted, [...SEED_OPERATIONS, ...clinic])).toEqual({
      operations: [],
      conflicts: [],
    });
  });

  it("reports a name the workspace's own object uses and still adds the rest", () => {
    const custom = applyValid(
      legacy,
      [
        {
          op: 'create_object',
          object: {
            nameSingular: 'conversation',
            namePlural: 'conversations',
            labelSingular: 'Conversation',
            labelPlural: 'Conversations',
            labelField: 'name',
            fields: [{ name: 'name', label: 'Name', type: 'text' }],
          },
        },
      ],
      'agent',
    );
    const { operations, conflicts } = upgrade(custom, SEED_OPERATIONS);
    expect(conflicts).toEqual([
      { element: 'conversation', message: expect.stringContaining('already used') },
    ]);
    expect(created(operations)).toEqual(['internalNote', 'workspaceProfile', 'memberProfile']);
  });

  it('adds a missing template field to an existing object, but not to a deleted one', () => {
    const { older, object, field } = withoutField(
      clinic,
      'appointment',
      (f, o) => f.name !== o.labelField,
    );
    const withOlder = applyValid(seeded, older);
    const { operations, conflicts } = upgrade(withOlder, [...SEED_OPERATIONS, ...clinic]);
    expect(conflicts).toEqual([]);
    expect(operations).toEqual([
      expect.objectContaining({
        op: 'create_field',
        object: object.universalId,
        field: expect.objectContaining({ universalId: field.universalId }),
      }),
    ]);

    const deleted = applyValid(withOlder, [{ op: 'delete_object', object: 'appointment' }]);
    expect(planUpgrade(deleted, [...SEED_OPERATIONS, ...clinic]).operations).toEqual([]);
  });

  it('reports a template field whose relation target the workspace deleted', () => {
    // An older viewing without its property, in a workspace that deleted properties.
    const { older } = withoutField(realEstate, 'viewing', (f) => f.name === 'property');
    const withOlder = applyValid(seeded, older);
    const noProperties = applyValid(withOlder, [{ op: 'delete_object', object: 'property' }]);
    const { operations, conflicts } = planUpgrade(noProperties, [
      ...SEED_OPERATIONS,
      ...realEstate,
    ]);
    expect(operations).toEqual([]);
    expect(conflicts).toEqual([
      { element: 'viewing.property', message: expect.stringContaining('property') },
    ]);
  });
});

describe('built-in definitions', () => {
  it('refer to objects by universal ID, which survives a workspace renaming them', () => {
    const all = [SEED_OPERATIONS, ...Object.values(TEMPLATES).map((t) => t.operations)].flat();
    const ids = new Set(
      all.flatMap((o) => (o.op === 'create_object' ? [o.object.universalId] : [])),
    );
    const references = all.flatMap((o) => {
      const fields =
        o.op === 'create_object' ? o.object.fields : o.op === 'create_field' ? [o.field] : [];
      return [
        ...(o.op === 'create_field' ? [o.object] : []),
        ...fields.flatMap((f) => [
          ...(f.settings?.targetObject ? [f.settings.targetObject] : []),
          ...(f.settings?.targetObjects ?? []),
        ]),
      ];
    });
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((ref) => !ids.has(ref))).toEqual([]);
  });
});

describe('protection on upgrade', () => {
  it('diffs protection for unprotected base elements as additive', () => {
    const unprotected = structuredClone(seeded);
    for (const object of unprotected.objects) {
      object.isProtected = false;
      for (const field of object.fields) field.isProtected = false;
    }
    const desired = structuredClone(unprotected);
    applyProtection(desired);
    const ops = diffSchemas(unprotected, desired);
    expect(
      ops.map((op) =>
        op.kind === 'protect_field'
          ? [op.kind, `${op.object}.${op.field}`]
          : op.kind === 'protect_object'
            ? [op.kind, op.object]
            : [op.kind],
      ),
    ).toEqual([
      ['protect_object', 'company'],
      ['protect_object', 'person'],
      ['protect_object', 'task'],
      ['protect_field', 'task.status'],
      ['protect_field', 'task.dueDate'],
      ['protect_object', 'internalNote'],
      ['protect_object', 'workspaceProfile'],
      ['protect_object', 'memberProfile'],
    ]);
    expect(ops.every((op) => classifyOp(op) === 'additive')).toBe(true);
    // Core fields are protected when created; the lists do not name them.
    expect(desired.objects.flatMap((o) => o.fields).filter((f) => f.isProtected)).toHaveLength(2);
    expect(diffSchemas(seeded, seeded)).toEqual([]);
  });
});

describe('definitionsFor', () => {
  it('includes the seed and the applied templates, and digests them', () => {
    const none = definitionsFor([]);
    expect(none.operations).toEqual(SEED_OPERATIONS);
    const applied = (name: string) => ({ name, version: 1, appliedAt: '2026-01-01T00:00:00Z' });
    const withClinic = definitionsFor([applied('clinic')]);
    expect(withClinic.operations).toEqual([...SEED_OPERATIONS, ...clinic]);
    expect(withClinic.digest).not.toBe(none.digest);
    // Same templates in any order, repeated or with other versions: same digest.
    expect(definitionsFor([applied('sales'), applied('clinic'), applied('sales')]).digest).toBe(
      definitionsFor([{ ...applied('clinic'), version: 7 }, applied('sales')]).digest,
    );
    // An unknown template name is ignored.
    expect(definitionsFor([applied('dentist')]).digest).toBe(none.digest);
  });
});
