import type { FieldType, FieldView, ObjectView, SchemaDiffField } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { sortObjects } from '../state.js';
import {
  ABOUT_ROW,
  ANY_RECORD_NODE,
  aboutEdges,
  canRollUpEvents,
  cardinality,
  describeDiffOp,
  describeOperation,
  groupSchemaDiff,
  isManyRelation,
  matchesField,
  parseStatus,
  relationEdges,
  relationEnds,
  relativeTime,
  summarizeSchemaChange,
  typeDetail,
} from './schema-model.js';

const field = (over: Partial<FieldView> & Pick<FieldView, 'name' | 'type'>): FieldView => ({
  isProtected: false,
  label: over.name,
  description: null,
  settings: {},
  readOnly: false,
  owner: 'system',
  isNullable: true,
  isUnique: false,
  isFilterable: false,
  isSearchable: false,
  ...over,
});
const object = (over: Partial<ObjectView> & Pick<ObjectView, 'nameSingular'>): ObjectView => ({
  isProtected: false,
  class: 'entity',
  namePlural: `${over.nameSingular}s`,
  labelSingular: over.nameSingular,
  labelPlural: `${over.nameSingular}s`,
  description: null,
  labelField: 'name',
  owner: 'system',
  fields: [],
  ...over,
});
const person = object({
  nameSingular: 'person',
  namePlural: 'people',
  labelSingular: 'Person',
  labelPlural: 'People',
  fields: [
    field({ name: 'name', label: 'Name', type: 'text' }),
    field({
      name: 'relationship',
      label: 'Relationship',
      type: 'select',
      settings: { options: [{ value: 'advisor', label: 'Advisor' }] },
    }),
    field({
      name: 'company',
      label: 'Company',
      type: 'relation',
      settings: {
        targetObject: 'company',
        inverseField: 'people',
        relationCardinality: 'many_to_one',
      },
    }),
  ],
});
const company = object({
  nameSingular: 'company',
  namePlural: 'companies',
  labelSingular: 'Company',
  labelPlural: 'Companies',
  fields: [
    field({
      name: 'people',
      label: 'People',
      type: 'relation',
      readOnly: true,
      settings: {
        targetObject: 'person',
        inverseField: 'company',
        relationCardinality: 'one_to_many',
        isInverse: true,
      },
    }),
  ],
});
const deal = object({ nameSingular: 'deal', owner: 'agent' });
const objects = [deal, person, company];

describe('schema page model', () => {
  it('puts system objects first and keeps schema order otherwise', () => {
    expect(sortObjects(objects).map((o) => o.nameSingular)).toEqual(['person', 'company', 'deal']);
  });

  it('draws each relation once, from its many side to its one side', () => {
    expect(relationEdges(objects)).toEqual([
      {
        id: 'person.company',
        from: { node: 'person', row: 'company' },
        to: { node: 'company', row: 'people' },
        description: 'Company: Each person has one company. Each company has many people.',
      },
    ]);
  });

  it('keeps a one-to-many field without its other side, and drops missing targets', () => {
    const lonely = object({
      nameSingular: 'company',
      labelSingular: 'Company',
      labelPlural: 'Companies',
      fields: [
        field({
          name: 'staff',
          label: 'Staff',
          type: 'relation',
          settings: { targetObject: 'person', relationCardinality: 'one_to_many', isInverse: true },
        }),
        field({ name: 'ghost', label: 'Ghost', type: 'relation', settings: { targetObject: 'x' } }),
      ],
    });
    const edges = relationEdges([
      object({ nameSingular: 'person', labelSingular: 'Person' }),
      lonely,
    ]);
    expect(edges.map((e) => [e.from, e.to])).toEqual([
      [
        { node: 'person', row: undefined },
        { node: 'company', row: 'staff' },
      ],
    ]);
  });

  it('draws a many-to-many relation once, from its owning set, many at both ends', () => {
    const deal = object({
      nameSingular: 'deal',
      labelSingular: 'Deal',
      labelPlural: 'Deals',
      fields: [
        field({
          name: 'contacts',
          label: 'Contacts',
          type: 'relation',
          settings: {
            targetObject: 'person',
            inverseField: 'deals',
            relationCardinality: 'many_to_many',
          },
        }),
      ],
    });
    const people = object({
      nameSingular: 'person',
      labelSingular: 'Person',
      labelPlural: 'People',
      fields: [
        field({
          name: 'deals',
          label: 'Deals',
          type: 'relation',
          readOnly: true,
          settings: {
            targetObject: 'deal',
            inverseField: 'contacts',
            relationCardinality: 'many_to_many',
            isInverse: true,
          },
        }),
      ],
    });
    // Listed inverse first, so the inverse is the one skipped, not the first seen.
    expect(relationEdges([people, deal])).toEqual([
      {
        id: 'deal.contacts',
        from: { node: 'deal', row: 'contacts' },
        to: { node: 'person', row: 'deals' },
        toEnd: 'many',
        description: 'Contacts: Each deal has many people. Each person has many deals.',
      },
    ]);
    // Without its owning side, the inverse draws the line, pointing the same way.
    expect(relationEdges([people, { ...deal, fields: [] }])).toEqual([
      expect.objectContaining({
        from: { node: 'deal', row: undefined },
        to: { node: 'person', row: 'deals' },
        toEnd: 'many',
      }),
    ]);
    const [contacts] = deal.fields as [FieldView];
    const [deals] = people.fields as [FieldView];
    expect(typeDetail(contacts, [deal, people])).toBe('Many People');
    expect(typeDetail(deals, [deal, people])).toBe('Many Deals');
    expect([contacts, deals].map(isManyRelation)).toEqual([true, true]);
    expect(isManyRelation(person.fields[2] as FieldView)).toBe(false);
  });

  it('describes and draws a polymorphic relation to each object it allows', () => {
    const customer = (many: boolean) =>
      field({
        name: 'customer',
        label: 'Customer',
        type: 'relation',
        settings: {
          targetObjects: ['company', 'person'],
          relationCardinality: many ? 'many_to_many' : 'many_to_one',
        },
      });
    const deal = object({
      nameSingular: 'deal',
      labelSingular: 'Deal',
      labelPlural: 'Deals',
      fields: [customer(false)],
    });
    const all = [deal, person, company];
    expect(typeDetail(customer(false), all)).toBe('One Company or Person');
    expect(typeDetail(customer(true), all)).toBe('Many Companies or People');
    // A missing object keeps its API name in the type, and draws no line.
    expect(typeDetail(customer(false), [deal, company])).toBe('One Company or person');
    const ends = relationEnds(customer(false), all);
    expect(ends.target).toBeNull();
    expect(ends.inverse).toBeUndefined();
    expect(ends.targets.map((t) => t.object?.nameSingular)).toEqual(['company', 'person']);
    expect(cardinality(deal, [company, person], false)).toBe('Each deal has one company or person');
    const polymorphic = (objects: ObjectView[]) =>
      relationEdges(objects).filter((e) => e.from.node === 'deal');
    expect(polymorphic(all)).toEqual([
      {
        id: 'deal.customer:company',
        from: { node: 'deal', row: 'customer' },
        to: { node: 'company' },
        description: 'Customer: Each deal has one company or person. Each company has many deals.',
      },
      {
        id: 'deal.customer:person',
        from: { node: 'deal', row: 'customer' },
        to: { node: 'person' },
        description: 'Customer: Each deal has one company or person. Each person has many deals.',
      },
    ]);
    const set = { ...deal, fields: [customer(true)] };
    expect(polymorphic([set, person, company]).map((e) => e.toEnd)).toEqual(['many', 'many']);
    expect(polymorphic([deal, company]).map((e) => e.to.node)).toEqual(['company']);
  });

  it('offers event rollup only on owning relations of entities', () => {
    const [name, , toCompany] = person.fields as [FieldView, FieldView, FieldView];
    const [people] = company.fields as [FieldView];
    expect(canRollUpEvents(person, toCompany)).toBe(true);
    expect(canRollUpEvents(company, people)).toBe(false);
    expect(canRollUpEvents(person, name)).toBe(false);
    expect(canRollUpEvents({ class: 'event' }, toCompany)).toBe(false);
  });

  it('words cardinality the same way everywhere', () => {
    expect(cardinality(person, company, false)).toBe('Each person has one company');
    expect(cardinality(company, person, true)).toBe('Each company has many people');
    expect(cardinality(person, null, true)).toBe('Each person has many records');
  });

  it('describes what settings add to a type', () => {
    const [name, relationship, toCompany] = person.fields as [FieldView, FieldView, FieldView];
    expect(typeDetail(name, objects)).toBeNull();
    expect(typeDetail(relationship, objects)).toBe('1 option');
    expect(typeDetail(toCompany, objects)).toBe('One Company');
    expect(typeDetail(company.fields[0] as FieldView, objects)).toBe('Many People');
    expect(typeDetail(field({ name: 'e', type: 'emails', settings: { maxValues: 5 } }), [])).toBe(
      'Up to 5',
    );
  });

  it('filters fields by label, API name or type', () => {
    const f = person.fields[1] as FieldView;
    expect(matchesField(f, '')).toBe(true);
    expect(matchesField(f, 'RELATION')).toBe(true);
    expect(matchesField(f, 'single sel')).toBe(true);
    expect(matchesField(f, 'money')).toBe(false);
  });

  it('accepts only known change statuses', () => {
    expect(parseStatus('applied')).toBe('applied');
    expect(parseStatus('bogus')).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(relativeTime('2026-11-03T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-11-03T09:00:00Z', now)).toMatch(/3 hours ago/);
  });

  it('describes every operation in words, with labels from the schema', () => {
    const d = (op: Parameters<typeof describeOperation>[0]) => describeOperation(op, objects);
    expect(
      d({
        op: 'add_option',
        object: 'person',
        field: 'relationship',
        option: { value: 'collaborator', label: 'Collaborator' },
      }),
    ).toBe('Add option “Collaborator” to Person → Relationship');
    expect(
      d({ op: 'update_field', object: 'person', field: 'name', isUnique: true, isNullable: false }),
    ).toBe('Change Person → Name: required, unique');
    expect(d({ op: 'update_field', object: 'person', field: 'company', rollUpEvents: true })).toBe(
      'Change Person → Company: roll up events',
    );
    expect(d({ op: 'update_field', object: 'person', field: 'company', rollUpEvents: false })).toBe(
      'Change Person → Company: stop rolling up events',
    );
    expect(
      d({
        op: 'create_field',
        object: 'company',
        field: { name: 'arr', label: 'ARR', type: 'money' },
      }),
    ).toBe('Add field ARR (Money) to Company');
    expect(
      d({
        op: 'create_object',
        object: {
          nameSingular: 'touchpoint',
          namePlural: 'touchpoints',
          labelSingular: 'Touchpoint',
          labelPlural: 'Touchpoints',
          labelField: 'title',
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
        },
      }),
    ).toBe('Add object Touchpoint with 1 field');
    expect(d({ op: 'update_object', object: 'person', description: null })).toBe(
      'Change Person: clear description',
    );
    expect(d({ op: 'rename_field', object: 'person', field: 'name', name: 'fullName' })).toBe(
      'Rename Person → Name to fullName',
    );
    expect(d({ op: 'delete_field', object: 'ghost', field: 'gone' })).toBe(
      'Delete field ghost → gone',
    );
    expect(d({ op: 'remove_option', object: 'person', field: 'relationship', value: 'x' })).toBe(
      'Remove option x from Person → Relationship',
    );
    expect(
      describeOperation({ op: 'future_thing' } as unknown as Parameters<typeof d>[0], objects),
    ).toBe('future thing');
  });
});

describe('describeDiffOp', () => {
  it('describes kind-keyed diff operations, not “Unknown change”', () => {
    const d = (op: Parameters<typeof describeDiffOp>[0]) => describeDiffOp(op, objects);
    expect(
      d({
        kind: 'create_field',
        objectId: 'x',
        object: 'person',
        field: { name: 'linkedinUrl', label: 'LinkedIn URL', type: 'text' },
      }),
    ).toMatch(/^Add field LinkedIn URL \(.+\) to Person$/);
    expect(
      d({ kind: 'update_field', object: 'person', field: 'name', property: 'isUnique', to: true }),
    ).toBe('Change Person → Name: unique');
    expect(
      d({ kind: 'update_object', object: 'person', property: 'labelPlural', to: 'Humans' }),
    ).toBe('Change Person: plural label “Humans”');
    expect(d({ kind: 'deprecate_field', object: 'person', field: 'name' })).toBe(
      'Delete field Person → Name',
    );
    expect(d({ kind: 'future_thing' })).toBe('future thing');
  });
});

describe('the diagram’s about lines', () => {
  it('draw one dashed line from each event type’s About row to any entity', () => {
    const edges = aboutEdges([
      object({ nameSingular: 'company' }),
      object({ nameSingular: 'conversation', labelSingular: 'Conversation', class: 'event' }),
      object({ nameSingular: 'note', labelSingular: 'Note', class: 'event' }),
    ]);
    expect(edges.map((e) => [e.from, e.to, e.dashed])).toEqual([
      [{ node: 'conversation', row: ABOUT_ROW }, { node: ANY_RECORD_NODE }, true],
      [{ node: 'note', row: ABOUT_ROW }, { node: ANY_RECORD_NODE }, true],
    ]);
    expect(edges[0]?.description).toMatch(/conversation can be about any number of entities/);
    expect(aboutEdges([object({ nameSingular: 'company' })])).toEqual([]);
  });
});

describe('groupSchemaDiff', () => {
  // The server labels each step by universal ID; these are what it sends.
  const E = {
    objectId: 'E',
    object: 'engagement',
    objectLabel: 'Engagement',
    objectClass: 'entity' as const,
  };
  const T = { objectId: 'T', object: 'task', objectLabel: 'Task', objectClass: 'entity' as const };
  const ref = (
    o: typeof E,
    fieldId: string,
    field: string,
    fieldLabel: string,
    fieldType: FieldType,
  ) => ({ ...o, fieldId, field, fieldLabel, fieldType });
  const status = ref(T, 'TS', 'status', 'Status', 'select');
  const newField = (over: Partial<SchemaDiffField> & Pick<SchemaDiffField, 'name' | 'type'>) =>
    ({
      universalId: `u-${over.name}`,
      label: over.name,
      description: null,
      settings: {},
      isNullable: true,
      isUnique: false,
      isFilterable: false,
      isSearchable: false,
      isProtected: false,
      coreRole: null,
      owner: 'agent',
      ...over,
    }) satisfies SchemaDiffField;

  it('groups a rename by object and field, each property before and after', () => {
    const groups = groupSchemaDiff([
      {
        kind: 'rename_object',
        objectId: 'E',
        objectLabel: 'Engagement',
        objectClass: 'entity',
        from: { nameSingular: 'engagement', namePlural: 'engagements' },
        to: { nameSingular: 'project', namePlural: 'projects' },
      },
      {
        kind: 'update_object',
        ...E,
        object: 'project',
        property: 'labelSingular',
        from: 'Engagement',
        to: 'Project',
      },
      {
        kind: 'rename_field',
        ...T,
        fieldId: 'TE',
        fieldLabel: 'Engagement',
        fieldType: 'relation',
        from: 'engagement',
        to: 'project',
      },
      {
        kind: 'update_field',
        ...ref(T, 'TE', 'project', 'Engagement', 'relation'),
        property: 'label',
        from: 'Engagement',
        to: 'Project',
      },
    ]);
    expect(groups.map((g) => [g.id, g.object, g.label])).toEqual([
      ['E', 'project', 'Engagement'],
      ['T', 'task', 'Task'],
    ]);
    expect(groups[0]?.details).toEqual([
      {
        label: 'API name',
        before: 'engagement / engagements',
        after: 'project / projects',
        code: true,
      },
      { label: 'Name', before: 'Engagement', after: 'Project' },
    ]);
    expect(groups[1]?.fields).toEqual([
      {
        id: 'TE',
        label: 'Engagement',
        type: 'Relation',
        kind: 'changed',
        details: [
          { label: 'API name', before: 'engagement', after: 'project', code: true },
          { label: 'Label', before: 'Engagement', after: 'Project' },
        ],
      },
    ]);
    expect(summarizeSchemaChange(groups)).toBe('Rename Engagement to Project');
  });

  it('shows a new type with its fields, settings and label field', () => {
    const deal = {
      objectId: 'D',
      object: 'deal',
      objectLabel: 'Deal',
      objectClass: 'entity' as const,
    };
    const groups = groupSchemaDiff([
      {
        kind: 'create_object',
        object: {
          universalId: 'D',
          nameSingular: 'deal',
          namePlural: 'deals',
          labelSingular: 'Deal',
          labelPlural: 'Deals',
          description: null,
          labelField: 'title',
          labelFieldLabel: 'Deal name',
          isProtected: false,
          class: 'entity',
          owner: 'agent',
        },
      },
      {
        kind: 'create_field',
        ...deal,
        field: newField({
          name: 'title',
          label: 'Deal name',
          type: 'text',
          isNullable: false,
          isSearchable: true,
        }),
        targetLabels: [],
      },
      {
        kind: 'create_field',
        ...deal,
        field: newField({
          name: 'stage',
          label: 'Stage',
          type: 'select',
          settings: {
            options: [
              { value: 'won', label: 'Won' },
              { value: 'lost', label: 'Lost' },
            ],
          },
        }),
        targetLabels: [],
      },
      {
        kind: 'create_field',
        ...deal,
        field: newField({
          name: 'project',
          label: 'Project',
          type: 'relation',
          settings: {
            targetObject: 'engagement',
            relationCardinality: 'many_to_one',
            onDelete: 'cascade',
          },
        }),
        targetLabels: [{ singular: 'Engagement', plural: 'Engagements' }],
      },
      {
        kind: 'create_field',
        ...E,
        field: newField({
          name: 'deals',
          label: 'Deals',
          type: 'relation',
          settings: { targetObject: 'deal', relationCardinality: 'one_to_many', isInverse: true },
        }),
        targetLabels: [{ singular: 'Deal', plural: 'Deals' }],
      },
    ]);
    const [added, eng] = groups;
    expect(added?.kind).toBe('added');
    expect(added?.details).toEqual([
      { label: 'Name', after: 'Deal' },
      { label: 'Plural name', after: 'Deals' },
      { label: 'API name', after: 'deal / deals', code: true },
      { label: 'Label field', after: 'Deal name (title)' },
    ]);
    expect(added?.fields.map((f) => [f.label, f.type, f.kind, f.details])).toEqual([
      [
        'Deal name',
        'Text',
        'added',
        [
          { label: 'API name', after: 'title', code: true },
          { label: 'Behavior', after: 'Required · Searchable' },
        ],
      ],
      [
        'Stage',
        'Single select',
        'added',
        [
          { label: 'API name', after: 'stage', code: true },
          { label: 'Behavior', after: 'Optional' },
          { label: 'Options', after: 'Won (won), Lost (lost)' },
        ],
      ],
      [
        'Project',
        'Relation',
        'added',
        [
          { label: 'API name', after: 'project', code: true },
          { label: 'Behavior', after: 'Optional' },
          { label: 'Links to', after: 'One Engagement' },
          { label: 'If target is deleted', after: 'Delete this record too' },
        ],
      ],
    ]);
    // The other side of the new relation, on an existing type, links to the new one.
    expect(eng?.fields[0]?.details).toContainEqual({ label: 'Links to', after: 'Many Deals' });
    expect(summarizeSchemaChange(groups)).toBe('Add the Deal type');
  });

  it('marks deleted parts and reads flags, options and the label field in plain words', () => {
    const groups = groupSchemaDiff([
      { kind: 'update_field', ...status, property: 'isNullable', from: true, to: false },
      { kind: 'update_field', ...status, property: 'isUnique', from: false, to: true },
      { kind: 'update_option', ...status, value: 'todo', from: 'To do', to: 'Open' },
      { kind: 'remove_option', ...status, value: 'todo', optionLabel: 'To do' },
      { kind: 'remove_option', ...status, value: 'gone', optionLabel: null },
      { kind: 'add_option', ...status, option: { value: 'done', label: 'Done' } },
      { kind: 'deprecate_field', ...ref(E, 'EC', 'company', 'Company', 'relation') },
      {
        kind: 'update_object',
        ...E,
        property: 'labelField',
        from: 'name',
        to: 'company',
        fromLabel: 'Name',
        toLabel: 'Company',
      },
    ]);
    // The type whose own label field changes comes before one with only field changes.
    expect(groups.map((g) => g.id)).toEqual(['E', 'T']);
    expect(groups[1]?.fields[0]?.details).toEqual([
      { label: 'Required', before: 'No', after: 'Yes' },
      { label: 'Unique', before: 'No', after: 'Yes' },
      { label: 'Option', before: 'To do (todo)', after: 'Open (todo)' },
      { label: 'Removed option', before: 'To do (todo)' },
      { label: 'Removed option', before: 'gone' },
      { label: 'New option', after: 'Done (done)' },
    ]);
    expect(groups[0]?.fields[0]?.kind).toBe('removed');
    expect(groups[0]?.details).toEqual([
      { label: 'Label field', before: 'Name (name)', after: 'Company (company)' },
    ]);
    expect(summarizeSchemaChange(groups)).toBe(
      'Delete Company from Engagement and change Status on Task',
    );
  });

  it('keeps a deleted part apart from a new one with the same name', () => {
    const groups = groupSchemaDiff([
      { kind: 'deprecate_field', ...status },
      {
        kind: 'create_field',
        ...T,
        field: newField({ name: 'status', type: 'text' }),
        targetLabels: [],
      },
    ]);
    expect(groups[0]?.fields.map((f) => [f.id, f.type, f.kind])).toEqual([
      ['TS', 'Single select', 'removed'],
      ['u-status', 'Text', 'added'],
    ]);
  });

  it('names a field-only change after its field, and caps a long headline', () => {
    const unique = (r: ReturnType<typeof ref>) => ({
      kind: 'update_field' as const,
      ...r,
      property: 'isUnique' as const,
      from: false,
      to: true,
    });
    expect(summarizeSchemaChange(groupSchemaDiff([unique(status)]))).toBe('Change Status on Task');
    const three = groupSchemaDiff([
      unique(status),
      unique(ref(T, 'TE', 'engagement', 'Engagement', 'relation')),
      unique(ref(E, 'EN', 'name', 'Name', 'text')),
    ]);
    expect(summarizeSchemaChange(three)).toBe(
      'Change Status on Task, change Engagement on Task and 1 more',
    );
  });

  it('keeps a step from a newer server visible, in words', () => {
    const groups = groupSchemaDiff([{ kind: 'future_thing' } as never]);
    expect(groups[0]?.details).toEqual([{ label: 'future thing' }]);
  });
});
