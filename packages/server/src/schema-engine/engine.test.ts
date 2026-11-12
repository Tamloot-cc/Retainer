import { BASE_EVENT_TYPE_IDS, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import type { SchemaState } from '../schema/types.js';
import {
  BASE_EVENT_OPERATIONS,
  BASE_OBJECT_IDS,
  BASE_OPERATIONS,
  INTERNAL_OPERATIONS,
  TEMPLATES,
} from '../templates/index.js';
import { applyOperations, coreFieldUniversalId, deriveUuid } from './apply.js';
import { classifyOp, diffSchemas, isDestructive } from './diff.js';
import type { FieldDefinitionInput, SchemaOperation } from './operations.js';
import { schemaChangeKeys } from './persist.js';
import { validateSchema } from './validate.js';

const EMPTY: SchemaState = { objects: [] };

/** Applies operations and returns the desired state, failing on any issue. */
function applyValid(
  state: SchemaState,
  operations: SchemaOperation[],
  owner: 'agent' | 'system' = 'agent',
) {
  const { state: desired, issues } = applyOperations(state, operations, { owner });
  expect([...issues, ...validateSchema(desired)]).toEqual([]);
  return desired;
}

/** Reference issues from apply, or else validation issues. */
function issuesOf(state: SchemaState, operations: SchemaOperation[]) {
  const { state: desired, issues } = applyOperations(state, operations, { owner: 'agent' });
  return issues.length > 0 ? issues : validateSchema(desired);
}

const base = applyValid(EMPTY, BASE_OPERATIONS, 'system');

const field = (state: SchemaState, object: string, name: string) =>
  state.objects
    .find((o) => o.nameSingular === object)
    ?.fields.find((f) => f.name === name && f.status === 'active');

describe('base objects', () => {
  it('creates person, company and task with fixed universal IDs', () => {
    expect(base.objects.map((o) => [o.nameSingular, o.universalId])).toEqual([
      ['company', BASE_OBJECT_IDS.company],
      ['person', BASE_OBJECT_IDS.person],
      ['task', BASE_OBJECT_IDS.task],
    ]);
  });

  it('derives the same inverse fields every time', () => {
    const again = applyValid(EMPTY, BASE_OPERATIONS, 'system');
    expect(field(again, 'company', 'people')?.universalId).toBe(
      field(base, 'company', 'people')?.universalId,
    );
    const company = field(base, 'person', 'company');
    expect(field(base, 'company', 'people')).toMatchObject({
      type: 'relation',
      settings: {
        relationCardinality: 'one_to_many',
        targetObjectId: BASE_OBJECT_IDS.person,
        inverseFieldId: company?.universalId,
      },
    });
    expect(company?.settings.inverseFieldId).toBe(deriveUuid(`${company?.universalId}:inverse`));
  });

  it('makes person.emails unique, which is destructive outside the trusted seed path', () => {
    expect(field(base, 'person', 'emails')?.isUnique).toBe(true);
    const ops = diffSchemas(EMPTY, base);
    const emails = ops.find((op) => op.kind === 'create_field' && op.field.name === 'emails');
    expect(emails && classifyOp(emails)).toBe('destructive');
  });
});

describe('templates', () => {
  for (const template of Object.values(TEMPLATES)) {
    it(`${template.name} applies to the base objects with additive operations only`, () => {
      const desired = applyValid(base, template.operations, 'system');
      const ops = diffSchemas(base, desired);
      expect(ops.filter((op) => classifyOp(op) !== 'additive')).toEqual([]);
      expect(ops.length > 0).toBe(template.name !== 'blank');
    });
  }

  it('can all be applied to one workspace', () => {
    const all = Object.values(TEMPLATES).flatMap((t) => t.operations);
    const desired = applyValid(base, all, 'system');
    expect(desired.objects.map((o) => o.nameSingular)).toEqual([
      'company',
      'person',
      'task',
      'deal',
      'project',
      'proposal',
      'appointment',
      'property',
      'viewing',
      'job',
      'application',
    ]);
  });

  it('uses universal IDs no other template or base object uses', () => {
    const all = Object.values(TEMPLATES).flatMap((t) => t.operations);
    const desired = applyValid(base, all, 'system');
    const ids = desired.objects.flatMap((o) => [
      o.universalId,
      ...o.fields.map((f) => f.universalId),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds clinic fields to person', () => {
    const desired = applyValid(base, TEMPLATES.clinic.operations, 'system');
    expect(field(desired, 'person', 'dateOfBirth')?.type).toBe('date');
    expect(field(desired, 'person', 'appointments')?.settings.relationCardinality).toBe(
      'one_to_many',
    );
  });

  it('reports every collision with existing custom names', () => {
    const custom = applyValid(base, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'deal',
          namePlural: 'deals',
          labelSingular: 'Deal',
          labelPlural: 'Deals',
          labelField: 'title',
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
        },
      },
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'industry', label: 'I', type: 'text' },
      },
    ]);
    const issues = issuesOf(custom, TEMPLATES.sales.operations);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['deal', 'company.industry']));
  });
});

describe('apply', () => {
  it('assigns a key equal to the name and never reuses keys', () => {
    const withNotes = applyValid(base, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'notes', label: 'Notes', type: 'text' },
      },
    ]);
    expect(field(withNotes, 'person', 'notes')?.key).toBe('notes');
    const deleted = applyValid(withNotes, [
      { op: 'delete_field', object: 'person', field: 'notes' },
    ]);
    const recreated = applyValid(deleted, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'notes', label: 'Notes', type: 'text' },
      },
    ]);
    expect(field(recreated, 'person', 'notes')?.key).toBe('notes_2');
  });

  it('keeps the key when a field is renamed', () => {
    const renamed = applyValid(base, [
      { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' },
    ]);
    expect(field(renamed, 'person', 'role')?.key).toBe('jobTitle');
  });

  it('refuses type changes and names what to do instead', () => {
    expect(
      issuesOf(base, [{ op: 'update_field', object: 'person', field: 'jobTitle', type: 'number' }]),
    ).toEqual([
      {
        path: 'person.jobTitle',
        message: 'changing a field type is not supported; create a new field and delete this one',
      },
    ]);
  });

  it('lists the known objects for an unknown reference', () => {
    const [issue] = issuesOf(base, [{ op: 'delete_object', object: 'dela' }]);
    expect(issue?.message).toContain('objects: company, person, task');
  });

  it('protects base objects and label fields', () => {
    expect(issuesOf(base, [{ op: 'delete_object', object: 'person' }])[0]?.message).toContain(
      'is protected',
    );
    expect(
      issuesOf(base, [{ op: 'delete_field', object: 'person', field: 'name' }])[0]?.message,
    ).toContain('label field');
  });

  it('deprecates both sides of a relation together', () => {
    const desired = applyValid(base, [{ op: 'delete_field', object: 'task', field: 'company' }]);
    expect(field(desired, 'task', 'company')).toBeUndefined();
    expect(field(desired, 'company', 'tasks')).toBeUndefined();
  });

  it('deletes relations pointing at a deleted object', () => {
    const withDeal = applyValid(base, TEMPLATES.sales.operations);
    const desired = applyValid(withDeal, [{ op: 'delete_object', object: 'deal' }]);
    expect(field(desired, 'company', 'deals')).toBeUndefined();
    expect(field(desired, 'person', 'deals')).toBeUndefined();
    const ops = diffSchemas(withDeal, desired);
    expect(ops.map((op) => op.kind).sort()).toEqual([
      'deprecate_field',
      'deprecate_field',
      'deprecate_object',
    ]);
  });
});

describe('schema-level change keys', () => {
  /** Gives every object a database ID, as a loaded schema has. */
  const persisted = (state: SchemaState): SchemaState => ({
    objects: state.objects.map((o) => ({ ...o, id: `db-${o.nameSingular}` })),
  });
  const keyOf = (state: SchemaState, object: string, name: string) =>
    field(state, object, name)?.key as string;

  it('names a deprecated field and its relation inverse once per object type', () => {
    const current = persisted(base);
    const desired = applyValid(current, [{ op: 'delete_field', object: 'task', field: 'company' }]);
    expect(schemaChangeKeys(current, diffSchemas(current, desired))).toEqual(
      new Map([
        ['db-company', [keyOf(current, 'company', 'tasks')]],
        ['db-task', [keyOf(current, 'task', 'company')]],
      ]),
    );
  });

  it('names every active field of a deleted object and relations pointing at it', () => {
    const current = persisted(applyValid(base, TEMPLATES.sales.operations));
    const desired = applyValid(current, [{ op: 'delete_object', object: 'deal' }]);
    const keys = schemaChangeKeys(current, diffSchemas(current, desired));
    const deal = current.objects.find((o) => o.nameSingular === 'deal');
    expect(keys.get('db-deal')).toEqual(
      deal?.fields
        .filter((f) => f.status === 'active')
        .map((f) => f.key)
        .sort(),
    );
    expect(keys.get('db-company')).toEqual([keyOf(current, 'company', 'deals')]);
    expect(keys.get('db-person')).toEqual([keyOf(current, 'person', 'deals')]);
    expect([...keys.keys()].sort()).toEqual(['db-company', 'db-deal', 'db-person']);
  });

  it('records nothing for operations that hide no values', () => {
    const current = persisted(base);
    const desired = applyValid(current, [
      { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'positionTitle' },
    ]);
    expect(schemaChangeKeys(current, diffSchemas(current, desired)).size).toBe(0);
  });
});

describe('protection', () => {
  const object = (state: SchemaState, name: string) =>
    state.objects.find((o) => o.nameSingular === name);

  it('protects the base objects and the task fields server code reads', () => {
    expect(base.objects.filter((o) => o.isProtected).map((o) => o.nameSingular)).toEqual([
      'company',
      'person',
      'task',
    ]);
    const protectedFields = base.objects.flatMap((o) =>
      o.fields.filter((f) => f.isProtected).map((f) => `${o.nameSingular}.${f.name}`),
    );
    expect(protectedFields).toEqual(['task.status', 'task.dueDate']);
  });

  it('never protects what a template or a client creates', () => {
    const all = Object.values(TEMPLATES).flatMap((t) => t.operations);
    const desired = applyValid(base, all, 'system');
    const added = desired.objects.filter(
      (o) => !base.objects.some((b) => b.universalId === o.universalId),
    );
    expect(added.every((o) => !o.isProtected && o.fields.every((f) => !f.isProtected))).toBe(true);
    expect(desired.objects.filter((o) => o.isProtected)).toHaveLength(3);
    expect(added.length).toBeGreaterThan(0);
  });

  it('refuses to delete protected objects and fields', () => {
    for (const name of ['person', 'company', 'task']) {
      expect(issuesOf(base, [{ op: 'delete_object', object: name }])[0]?.message).toContain(
        'is protected',
      );
    }
    for (const name of ['status', 'dueDate']) {
      expect(
        issuesOf(base, [{ op: 'delete_field', object: 'task', field: name }])[0]?.message,
      ).toContain('is protected');
    }
  });

  it('allows renames, labels and descriptions of protected objects and fields', () => {
    const desired = applyValid(base, [
      { op: 'rename_object', object: 'task', nameSingular: 'todo', namePlural: 'todos' },
      { op: 'update_object', object: 'todo', labelSingular: 'To-do', labelPlural: 'To-dos' },
      { op: 'rename_field', object: 'todo', field: 'status', name: 'state' },
      { op: 'update_field', object: 'todo', field: 'state', label: 'State', description: 'x' },
      { op: 'rename_field', object: 'todo', field: 'dueDate', name: 'deadline' },
    ]);
    const todo = object(desired, 'todo');
    expect(todo?.isProtected).toBe(true);
    expect(field(desired, 'todo', 'state')).toMatchObject({ isProtected: true, label: 'State' });
    expect(field(desired, 'todo', 'deadline')?.isProtected).toBe(true);
  });

  it('refuses to reshape a protected field', () => {
    for (const change of [
      { isNullable: false },
      { isUnique: true },
      { isFilterable: false },
      { isSearchable: true },
    ]) {
      const [issue] = issuesOf(base, [
        { op: 'update_field', object: 'task', field: 'status', ...change },
      ]);
      expect(issue?.message).toContain('is protected');
    }
    // Setting a flag to the value it already has changes nothing.
    applyValid(base, [{ op: 'update_field', object: 'task', field: 'status', isFilterable: true }]);
  });

  it('keeps the done option but lets other task statuses change', () => {
    const [issue] = issuesOf(base, [
      { op: 'remove_option', object: 'task', field: 'status', value: 'done' },
    ]);
    expect(issue?.message).toContain('option "done" is protected');

    const desired = applyValid(base, [
      {
        op: 'add_option',
        object: 'task',
        field: 'status',
        option: { value: 'blocked', label: 'Blocked' },
      },
      { op: 'update_option', object: 'task', field: 'status', value: 'done', label: 'Finished' },
      { op: 'remove_option', object: 'task', field: 'status', value: 'in_progress' },
    ]);
    expect(field(desired, 'task', 'status')?.settings.options).toEqual([
      { value: 'todo', label: 'To do' },
      { value: 'done', label: 'Finished' },
      { value: 'blocked', label: 'Blocked' },
    ]);
  });
});

describe('many_to_many relations', () => {
  const contacts = (settings: object) =>
    ({
      op: 'create_field',
      object: 'task',
      field: {
        name: 'watchers',
        label: 'Watchers',
        type: 'relation',
        settings: { targetObject: 'person', relationCardinality: 'many_to_many', ...settings },
      },
    }) as SchemaOperation;

  it('creates an owning set and a read-only many_to_many inverse', () => {
    const state = applyValid(base, [contacts({ inverseField: 'watching' })]);
    const owner = field(state, 'task', 'watchers');
    expect(owner?.settings).toMatchObject({
      relationCardinality: 'many_to_many',
      onDelete: 'set_null',
    });
    expect(owner?.settings.isInverse).toBeUndefined();
    expect(field(state, 'person', 'watching')?.settings).toMatchObject({
      relationCardinality: 'many_to_many',
      isInverse: true,
      inverseFieldId: owner?.universalId,
    });
  });

  it('marks the inverse of a many_to_one relation too', () => {
    expect(field(base, 'company', 'people')?.settings.isInverse).toBe(true);
    expect(field(base, 'person', 'company')?.settings.isInverse).toBeUndefined();
  });

  it('refuses cascade, and changes or deletes on the inverse side', () => {
    expect(issuesOf(base, [contacts({ onDelete: 'cascade' })]).map((i) => i.message)).toEqual([
      'onDelete: cascade is not allowed on a many_to_many relation; use set_null',
    ]);
    const state = applyValid(base, [contacts({ inverseField: 'watching' })]);
    expect(
      issuesOf(state, [{ op: 'delete_field', object: 'person', field: 'watching' }]).map(
        (i) => i.message,
      ),
    ).toEqual(['an inverse relation field is removed by deleting its owning side']);
    expect(
      issuesOf(state, [
        { op: 'update_field', object: 'person', field: 'watching', isFilterable: true },
      ]).map((i) => i.message),
    ).toEqual(['an inverse relation field only takes label and description changes']);
  });
});

describe('polymorphic relations', () => {
  const customer = (settings: object) =>
    ({
      op: 'create_field',
      object: 'task',
      field: { name: 'customer', label: 'Customer', type: 'relation', settings },
    }) as SchemaOperation;

  it('stores every allowed target, and one target as an ordinary relation', () => {
    const state = applyValid(base, [customer({ targetObjects: ['company', 'person'] })]);
    expect(field(state, 'task', 'customer')?.settings).toMatchObject({
      targetObjectIds: [BASE_OBJECT_IDS.company, BASE_OBJECT_IDS.person],
      relationCardinality: 'many_to_one',
    });
    expect(field(state, 'task', 'customer')?.settings.targetObjectId).toBeUndefined();
    const single = applyValid(base, [customer({ targetObjects: ['company', 'company'] })]);
    expect(field(single, 'task', 'customer')?.settings).toMatchObject({
      targetObjectId: BASE_OBJECT_IDS.company,
    });
    const set = applyValid(base, [
      customer({ targetObjects: ['company', 'person'], relationCardinality: 'many_to_many' }),
    ]);
    expect(field(set, 'task', 'customer')?.settings.relationCardinality).toBe('many_to_many');
  });

  it('refuses an inverse, both target forms, and unknown targets', () => {
    const messages = (settings: object) =>
      issuesOf(base, [customer(settings)]).map((i) => i.message);
    expect(messages({ targetObjects: ['company', 'person'], inverseField: 'owned' })[0]).toMatch(
      /no inverseField/,
    );
    expect(messages({ targetObject: 'company', targetObjects: ['person'] })[0]).toMatch(/not both/);
    expect(messages({ targetObjects: ['company', 'planet'] })[0]).toMatch(
      /unknown object "planet"/,
    );
  });

  it('refuses to delete one of several targets, naming the field', () => {
    const state = applyValid(base, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'household',
          namePlural: 'households',
          labelSingular: 'Household',
          labelPlural: 'Households',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
      customer({ targetObjects: ['company', 'household'] }),
    ]);
    expect(
      issuesOf(state, [{ op: 'delete_object', object: 'household' }]).map((i) => i.message),
    ).toEqual([expect.stringContaining('task.customer')]);
    // Once the field is gone, the object can be deleted.
    const without = applyValid(state, [{ op: 'delete_field', object: 'task', field: 'customer' }]);
    applyValid(without, [{ op: 'delete_object', object: 'household' }]);
  });
});

describe('event rollups', () => {
  const toggle = (on: boolean): SchemaOperation => ({
    op: 'update_field',
    object: 'person',
    field: 'company',
    rollUpEvents: on,
  });

  it('turns on and off as an additive change, storing only on', () => {
    const on = applyValid(base, [toggle(true)]);
    expect(field(on, 'person', 'company')?.settings.rollUpEvents).toBe(true);
    const ops = diffSchemas(base, on);
    expect(ops).toEqual([
      expect.objectContaining({ kind: 'update_field', property: 'rollUpEvents', to: true }),
    ]);
    expect(isDestructive(ops)).toBe(false);
    const off = applyValid(on, [toggle(false)]);
    expect(field(off, 'person', 'company')?.settings).not.toHaveProperty('rollUpEvents');
    expect(diffSchemas(base, off)).toEqual([]);
    expect(isDestructive(diffSchemas(on, off))).toBe(false);
    const created = applyValid(base, [
      {
        op: 'create_field',
        object: 'task',
        field: {
          name: 'account',
          label: 'Account',
          type: 'relation',
          settings: { targetObject: 'company', rollUpEvents: false },
        },
      },
    ]);
    expect(field(created, 'task', 'account')?.settings).not.toHaveProperty('rollUpEvents');
  });

  it('is refused on inverses, event types and other field types', () => {
    const message = (state: SchemaState, operations: SchemaOperation[]) =>
      issuesOf(state, operations)[0]?.message;
    expect(
      message(base, [
        { op: 'update_field', object: 'company', field: 'people', rollUpEvents: true },
      ]),
    ).toMatch(/not its inverse/);
    expect(
      message(base, [
        { op: 'update_field', object: 'person', field: 'jobTitle', rollUpEvents: true },
      ]),
    ).toMatch(/only to relation fields/);
    expect(
      message(base, [
        {
          op: 'create_field',
          object: 'task',
          field: { name: 'memo', label: 'Memo', type: 'text', settings: { rollUpEvents: true } },
        },
      ]),
    ).toMatch(/rollUpEvents/);
    expect(
      message(base, [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'payment',
            namePlural: 'payments',
            labelSingular: 'Payment',
            labelPlural: 'Payments',
            fields: [
              {
                name: 'payer',
                label: 'Payer',
                type: 'relation',
                settings: { targetObject: 'company', rollUpEvents: true },
              },
            ],
          },
        },
      ]),
    ).toMatch(/already attaches the event/);
  });

  it('is on in templates only for relations a record belongs to', () => {
    const on = Object.values(TEMPLATES).flatMap((template) => {
      const state = applyValid(base, template.operations, 'system');
      return state.objects.flatMap((o) =>
        o.fields.filter((f) => f.settings.rollUpEvents).map((f) => `${o.nameSingular}.${f.name}`),
      );
    });
    // Affiliations, ownership and contact assignments stay off (7.2).
    expect(on.sort()).toEqual([
      'application.job',
      'application.person',
      'appointment.person',
      'proposal.project',
      'viewing.person',
      'viewing.property',
    ]);
  });
});

describe('event types', () => {
  const seeded = applyValid(
    base,
    [...BASE_EVENT_OPERATIONS, ...INTERNAL_OPERATIONS] as SchemaOperation[],
    'system',
  );
  const object = (state: SchemaState, name: string) =>
    state.objects.find((o) => o.nameSingular === name);
  const payment = {
    op: 'create_object',
    object: {
      nameSingular: 'payment',
      namePlural: 'payments',
      labelSingular: 'Payment',
      labelPlural: 'Payments',
      class: 'event',
      fields: [{ name: 'amount', type: 'money' }],
    },
  } as SchemaOperation;

  it('seeds the base event types and the internal-note type with fixed universal IDs', () => {
    const events = seeded.objects.filter((o) => o.class === 'event');
    expect(Object.fromEntries(events.map((o) => [o.nameSingular, o.universalId]))).toEqual({
      conversation: BASE_EVENT_TYPE_IDS.conversation,
      internalNote: INTERNAL_NOTE_TYPE_ID,
    });
    // Base event types can be deleted when unused; the internal one cannot.
    expect(events.filter((o) => o.isProtected).map((o) => o.nameSingular)).toEqual([
      'internalNote',
    ]);
    expect(base.objects.every((o) => o.class === 'entity')).toBe(true);
  });

  it('gives an event type named note its reserved universal ID, not a pinned one', () => {
    const note = {
      op: 'create_object',
      object: {
        nameSingular: 'note',
        namePlural: 'notes',
        labelSingular: 'Note',
        labelPlural: 'Notes',
        class: 'event',
        fields: [],
      },
    } as SchemaOperation;
    const state = applyValid(seeded, [note]);
    expect(object(state, 'note')?.universalId).toBe(BASE_EVENT_TYPE_IDS.note);
    // An entity of that name is not a note type, whatever it is called.
    const entity = {
      op: 'create_object',
      object: {
        nameSingular: 'note',
        namePlural: 'notes',
        labelSingular: 'Note',
        labelPlural: 'Notes',
        labelField: 'text',
        fields: [{ name: 'text', label: 'Text', type: 'text' }],
      },
    } as SchemaOperation;
    expect(object(applyValid(seeded, [entity]), 'note')?.universalId).not.toBe(
      BASE_EVENT_TYPE_IDS.note,
    );
    // Added again after deletion, the old row keeps the ID and the new one gets its own.
    const again = applyValid(
      applyValid(state, [{ op: 'delete_object', object: 'note' }], 'system'),
      [note],
    );
    const added = again.objects.find((o) => o.nameSingular === 'note' && o.status === 'active');
    expect(added?.universalId).toBeDefined();
    expect(added?.universalId).not.toBe(BASE_EVENT_TYPE_IDS.note);
  });

  it('gives a new event type protected title and summary fields, the title as its label', () => {
    const state = applyValid(seeded, [payment]);
    const created = object(state, 'payment');
    const title = created?.fields.find((f) => f.coreRole === 'title');
    const summary = created?.fields.find((f) => f.coreRole === 'summary');
    expect(title).toMatchObject({
      name: 'title',
      type: 'text',
      isProtected: true,
      isSearchable: true,
      universalId: coreFieldUniversalId(created?.universalId as string, 'title'),
    });
    expect(summary).toMatchObject({ name: 'summary', type: 'text', isProtected: true });
    expect(created?.labelFieldId).toBe(title?.universalId);
    expect(created?.fields.map((f) => f.name)).toEqual(['title', 'summary', 'amount']);
  });

  it('derives the same core field IDs for a code-defined type every time', () => {
    const again = applyValid(base, BASE_EVENT_OPERATIONS as SchemaOperation[], 'system');
    const ids = (state: SchemaState) =>
      object(state, 'conversation')?.fields.map((f) => f.universalId);
    expect(ids(again)).toEqual(ids(seeded));
  });

  it('refuses core fields in the definition and a label other than the title', () => {
    const withTitle = {
      ...payment,
      object: {
        ...(payment as { object: object }).object,
        fields: [{ name: 'title', type: 'text' }],
      },
    } as SchemaOperation;
    expect(
      issuesOf(seeded, [withTitle])
        .map((i) => i.message)
        .join(' '),
    ).toMatch(/title/);
    const otherLabel = {
      ...payment,
      object: { ...(payment as { object: object }).object, labelField: 'amount' },
    } as SchemaOperation;
    expect(issuesOf(seeded, [otherLabel]).map((i) => i.message)).toContain(
      "an event type's labelField is always its title",
    );
    expect(
      issuesOf(seeded, [
        { op: 'update_object', object: 'conversation', labelField: 'summary' },
      ]).map((i) => i.message),
    ).toContain("an event type's labelField is always its title");
  });

  it('protects the core fields of every event type', () => {
    expect(
      issuesOf(seeded, [{ op: 'delete_field', object: 'conversation', field: 'summary' }])
        .map((i) => i.message)
        .join(' '),
    ).toContain('protected');
    // Renaming a core field is allowed; it keeps its role.
    const renamed = applyValid(seeded, [
      { op: 'rename_field', object: 'conversation', field: 'title', name: 'subject' },
    ]);
    expect(field(renamed, 'conversation', 'subject')?.coreRole).toBe('title');
  });

  it('still requires fields and a labelField on an entity', () => {
    const widget = (fields: object[]) =>
      ({
        op: 'create_object',
        object: {
          nameSingular: 'widget',
          namePlural: 'widgets',
          labelSingular: 'Widget',
          labelPlural: 'Widgets',
          fields,
        },
      }) as SchemaOperation;
    expect(
      issuesOf(seeded, [widget([])])
        .map((i) => i.message)
        .join(' '),
    ).toContain('at least one');
    expect(
      issuesOf(seeded, [widget([{ name: 'name', type: 'text' }])]).map((i) => i.message),
    ).toContain('an object needs a labelField');
  });

  it('reserves the built-in event column names as event field names', () => {
    for (const name of ['occurredAt', 'channel', 'externalId', 'participants', 'about', 'via']) {
      const op = {
        op: 'create_field',
        object: 'conversation',
        field: { name, type: 'text' },
      } as SchemaOperation;
      expect(issuesOf(seeded, [op]).length, name).toBeGreaterThan(0);
    }
  });

  it('hides the internal-note type from name lookups', () => {
    expect(
      issuesOf(seeded, [
        {
          op: 'create_field',
          object: 'internalNote',
          field: { name: 'extra', type: 'text' },
        } as SchemaOperation,
      ])
        .map((i) => i.message)
        .join(' '),
    ).toMatch(/internalNote/);
  });
});

describe('validate', () => {
  const create = (overrides: Partial<FieldDefinitionInput>) =>
    issuesOf(base, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'x', label: 'X', type: 'text', ...overrides },
      },
    ]);

  const createObject = (nameSingular: string, namePlural: string) =>
    issuesOf(base, [
      {
        op: 'create_object',
        object: {
          nameSingular,
          namePlural,
          labelSingular: 'X',
          labelPlural: 'Xs',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
    ]).map((i) => i.message);

  it('rejects reserved and badly formed names', () => {
    expect(create({ name: 'createdAt' })[0]?.message).toContain('reserved');
    expect(create({ name: 'Foo bar' })[0]?.message).toContain('camelCase');
    expect(createObject('record', 'records')).toEqual([
      '"record" is reserved: it names a built-in API resource',
      '"records" is reserved: it names a built-in API resource',
    ]);
  });

  it.each([
    ['interaction', 'interactions', 'log_event'],
    ['fact', 'facts', 'remember'],
  ])('points an object named %s at the built-in feature', (singular, plural, tool) => {
    for (const message of createObject(singular, plural)) expect(message).toContain(tool);
  });

  it('rejects duplicate field names', () => {
    expect(create({ name: 'jobTitle' })[0]?.message).toContain('already used');
  });

  it('rejects unique phones and other unsupported unique types', () => {
    expect(create({ type: 'phones', isUnique: true })[0]?.message).toContain(
      'shared and reassigned',
    );
    expect(create({ type: 'address', isUnique: true })[0]?.message).toContain('cannot be unique');
  });

  it('requires options on select fields and unique option values', () => {
    expect(create({ type: 'select' })[0]?.message).toContain('at least one option');
    expect(
      create({
        type: 'select',
        settings: {
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'A2' },
          ],
        },
      })[0]?.message,
    ).toContain('listed twice');
  });

  it('requires a relation target', () => {
    expect(create({ type: 'relation' })[0]?.message).toContain('targetObject');
    expect(create({ type: 'relation', settings: { targetObject: 'nope' } })[0]?.message).toContain(
      'unknown object',
    );
  });

  it('rejects object names that collide across singular and plural', () => {
    const issues = issuesOf(base, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'people',
          namePlural: 'peoples',
          labelSingular: 'P',
          labelPlural: 'Ps',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
    ]);
    expect(issues[0]?.message).toContain('already used by person');
  });
});

describe('diff and classify', () => {
  const diff = (operations: SchemaOperation[]) => diffSchemas(base, applyValid(base, operations));

  it('treats new objects, optional fields, options and labels as additive', () => {
    const ops = diff([
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'nickname', label: 'Nickname', type: 'text' },
      },
      {
        op: 'add_option',
        object: 'task',
        field: 'status',
        option: { value: 'blocked', label: 'Blocked' },
      },
      {
        op: 'update_field',
        object: 'person',
        field: 'jobTitle',
        label: 'Role',
        isSearchable: false,
      },
      { op: 'update_object', object: 'task', description: 'Work items' },
    ]);
    // Operations follow object order: person, then task.
    expect(ops.map((op) => [op.kind, classifyOp(op)])).toEqual([
      ['update_field', 'additive'],
      ['update_field', 'destructive'], // un-marking searchable is not listed as additive
      ['create_field', 'additive'],
      ['update_object', 'additive'],
      ['add_option', 'additive'],
    ]);
  });

  it('treats renames, deletions, removed options, required and unique as destructive', () => {
    const cases: SchemaOperation[][] = [
      [{ op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' }],
      [{ op: 'rename_object', object: 'task', nameSingular: 'todo', namePlural: 'todos' }],
      [{ op: 'delete_field', object: 'person', field: 'jobTitle' }],
      [{ op: 'remove_option', object: 'task', field: 'status', value: 'in_progress' }],
      [{ op: 'update_field', object: 'person', field: 'jobTitle', isNullable: false }],
      [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'ssn', label: 'SSN', type: 'text', isUnique: true },
        },
      ],
      [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'tier', label: 'Tier', type: 'text', isNullable: false },
        },
      ],
    ];
    for (const operations of cases) {
      expect(isDestructive(diff(operations)), JSON.stringify(operations)).toBe(true);
    }
  });

  it('reports a rename as a rename, matched by universal ID', () => {
    expect(
      diff([{ op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' }]),
    ).toEqual([expect.objectContaining({ kind: 'rename_field', from: 'jobTitle', to: 'role' })]);
  });

  it('produces no operations when nothing changes', () => {
    expect(
      diff([{ op: 'update_field', object: 'person', field: 'jobTitle', label: 'Job title' }]),
    ).toEqual([]);
  });
});
