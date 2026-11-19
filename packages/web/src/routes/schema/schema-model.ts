import {
  type DiffTargetLabel,
  type FieldType,
  type FieldView,
  isInverseRelation,
  type ObjectClass,
  type ObjectView,
  relationTargets,
  SCHEMA_CHANGE_STATUSES,
  type SchemaChangeStatus,
  type SchemaDiffField,
  type SchemaDiffOperation,
  type SchemaOperation,
} from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../../api/client.js';
import { joinOr, joinWords } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import type { DiagramEdge } from '../../ui/index.js';
import { objectByName } from '../state.js';

/**
 * A page of schema changes. The counts in the tab and top bar read `total`
 * from the first page, so opening the history reuses them; the proposed
 * first page is the review inbox's query too.
 */
export function useSchemaChanges(status?: SchemaChangeStatus, cursor?: string) {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [session.workspace.id, 'schemaChanges', status ?? 'all', cursor],
    queryFn: ({ signal }) => api.schemaChanges({ status, cursor, limit: 50, signal }),
  });
}

/** A second line under the type: what the settings add to it. */
export function typeDetail(field: FieldView, objects: ObjectView[]) {
  const s = field.settings;
  if (field.type === 'select' || field.type === 'multi_select') {
    const n = s.options?.length ?? 0;
    return `${n} ${n === 1 ? 'option' : 'options'}`;
  }
  if (field.type === 'relation') {
    const many = isManyRelation(field);
    const names = relationEnds(field, objects).targets.map(({ name, object }) =>
      object ? (many ? object.labelPlural : object.labelSingular) : name,
    );
    return `${many ? 'Many' : 'One'} ${joinOr(names) || 'unknown object'}`;
  }
  if (s.maxValues) return `Up to ${s.maxValues}`;
  return null;
}

/** Whether a field matches the field filter: label, API name or type. */
export function matchesField(field: FieldView, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [field.label, field.name, fields[field.type].label, field.type].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/**
 * A relation field's target objects (one, or several for a polymorphic
 * relation), each `null` when it no longer exists; `target` is the only one,
 * if there is exactly one; and, when it exists, the field on the other side.
 */
export function relationEnds(field: FieldView, objects: ObjectView[]) {
  const targets = relationTargets(field).map((name) => ({
    name,
    object: objectByName({ objects }, name),
  }));
  const target = targets.length === 1 ? (targets[0]?.object ?? null) : null;
  const inverse = target?.fields.find((f) => f.name === field.settings.inverseField);
  return { target, targets, inverse };
}

/**
 * "Each person has one company", or "… has many people" for the many side;
 * "Each deal has one company or person" for a polymorphic relation.
 */
export function cardinality(
  object: ObjectView,
  target: ObjectView | readonly ObjectView[] | null,
  many: boolean,
) {
  const targets = target === null ? [] : 'nameSingular' in target ? [target] : target;
  const names = targets.map((t) => (many ? t.labelPlural : t.labelSingular).toLowerCase());
  const what = `${many ? 'many' : 'one'} ${joinOr(names) || (many ? 'records' : 'record')}`;
  return `Each ${object.labelSingular.toLowerCase()} has ${what}`;
}

/**
 * Whether a field can roll up events: the owning side of a relation on an
 * entity. Events attached to a record then also show on the record it points
 * to. Inverse fields and event types can't.
 */
export const canRollUpEvents = (object: Pick<ObjectView, 'class'>, field: FieldView) =>
  field.type === 'relation' && !isInverseRelation(field) && object.class === 'entity';

/** Whether each record holds many related records here: a set, or an inverse list. */
export const isManyRelation = (f: FieldView) =>
  f.settings.relationCardinality === 'one_to_many' ||
  f.settings.relationCardinality === 'many_to_many';
const isOwning = (f: FieldView) => !isInverseRelation(f);

/**
 * Every relation once, as a line from its owning field (the side that is
 * written) to the inverse. A relation has a field on each side (Person →
 * Company and Company → People): it is drawn from the owning field, and from
 * an inverse field only when that other side is missing. A many-to-many
 * relation (Deal → Contacts and Person → Deals) has a "many" end at both.
 * A polymorphic relation (Deal → Customer, a company or a person) has a line
 * to each object it allows. Objects that no longer exist are left out.
 */
export function relationEdges(objects: ObjectView[]): DiagramEdge[] {
  return objects.flatMap((object) =>
    object.fields.flatMap((field): DiagramEdge[] => {
      if (field.type !== 'relation') return [];
      const { target, targets, inverse } = relationEnds(field, objects);
      const bothMany = field.settings.relationCardinality === 'many_to_many';
      if (targets.length > 1) {
        // Polymorphic: a line to each allowed object, which has no field back.
        const allowed = targets.flatMap((t) => (t.object ? [t.object] : []));
        const sentence = `${field.label}: ${cardinality(object, allowed, bothMany)}.`;
        return allowed.map((dest) => ({
          id: `${object.nameSingular}.${field.name}:${dest.nameSingular}`,
          from: { node: object.nameSingular, row: field.name },
          to: { node: dest.nameSingular },
          ...(bothMany ? { toEnd: 'many' as const } : {}),
          description: `${sentence} ${cardinality(dest, object, true)}.`,
        }));
      }
      if (!target || (!isOwning(field) && inverse && isOwning(inverse))) return [];
      const own = { node: object.nameSingular, row: field.name },
        other = { node: target.nameSingular, row: inverse?.name };
      const [source, dest] = isOwning(field) ? [object, target] : [target, object];
      return [
        {
          id: `${object.nameSingular}.${field.name}`,
          ...(isOwning(field) ? { from: own, to: other } : { from: other, to: own }),
          ...(bothMany ? { toEnd: 'many' as const } : {}),
          description: `${field.label}: ${cardinality(source, dest, bothMany)}. ${cardinality(dest, source, true)}.`,
        },
      ];
    }),
  );
}

/** The diagram's stand-in for "any entity", which an event's `about` link can name (C4). */
export const ANY_RECORD_NODE = '__any_record';
/** The row each event type's card gives its `about` link. */
export const ABOUT_ROW = 'about';

/**
 * Each event type's `about` link: one dashed line from its About row to "any
 * entity". It is built in, not a relation field, so it never names an object.
 */
export function aboutEdges(objects: ObjectView[]): DiagramEdge[] {
  return objects
    .filter((o) => o.class === 'event')
    .map((o) => ({
      id: `${o.nameSingular}.${ABOUT_ROW}`,
      from: { node: o.nameSingular, row: ABOUT_ROW },
      to: { node: ANY_RECORD_NODE },
      toEnd: 'many' as const,
      dashed: true,
      description: `About: each ${o.labelSingular.toLowerCase()} can be about any number of entities.`,
    }));
}

export function parseStatus(value: string | undefined): SchemaChangeStatus | undefined {
  return SCHEMA_CHANGE_STATUSES.find((s) => s === value);
}

export { relativeTime } from '../../ui/entry.js';

/**
 * Each field flag: its name as a property, and the words for turning it on
 * and off. "Required" reads the opposite way to `isNullable`.
 */
const FLAGS: Record<string, { name: string; words: [string, string]; inverted?: boolean }> = {
  isNullable: { name: 'Required', words: ['can be empty', 'required'], inverted: true },
  isUnique: { name: 'Unique', words: ['unique', 'not unique'] },
  isFilterable: { name: 'Filterable', words: ['filterable', 'not filterable'] },
  isSearchable: { name: 'Searchable', words: ['searchable', 'not searchable'] },
  rollUpEvents: { name: 'Rolls up events', words: ['roll up events', 'stop rolling up events'] },
};
const FLAG_WORDS = Object.fromEntries(Object.entries(FLAGS).map(([k, f]) => [k, f.words]));
/** A field type's name in words, or the raw type when this app doesn't know it. */
const typeLabel = (type: string) => fields[type as keyof typeof fields]?.label ?? type;
/**
 * One schema operation in words, with labels from the current schema where
 * the object or field still exists ("Add option “Collaborator” to Person →
 * Relationship"). Unknown shapes fall back to the operation name.
 */
export function describeOperation(op: SchemaOperation, objects: ObjectView[]) {
  const obj = (name: string) => objectByName({ objects }, name)?.labelSingular ?? name;
  const fld = (object: string, field: string) =>
    `${obj(object)} → ${objectByName({ objects }, object)?.fields.find((f) => f.name === field)?.label ?? field}`;
  const quote = (v: unknown) => `“${String(v)}”`;
  switch (op.op) {
    case 'create_object': {
      const n = op.object.fields?.length ?? 0;
      return `Add object ${op.object.labelSingular || op.object.nameSingular}${n ? ` with ${n} ${n === 1 ? 'field' : 'fields'}` : ''}`;
    }
    case 'update_object': {
      const parts = [
        op.labelSingular !== undefined && `singular label ${quote(op.labelSingular)}`,
        op.labelPlural !== undefined && `plural label ${quote(op.labelPlural)}`,
        op.labelField !== undefined && `label field ${op.labelField}`,
        op.description !== undefined &&
          (op.description ? `description ${quote(op.description)}` : 'clear description'),
      ].filter(Boolean);
      return `Change ${obj(op.object)}: ${parts.join(', ') || 'no changes'}`;
    }
    case 'rename_object':
      return `Rename object ${obj(op.object)} to ${op.nameSingular} / ${op.namePlural}`;
    case 'delete_object':
      return `Delete object ${obj(op.object)}`;
    case 'create_field': {
      const type = typeLabel(op.field.type);
      return `Add field ${op.field.label || op.field.name} (${type}) to ${obj(op.object)}`;
    }
    case 'update_field': {
      const parts = [
        op.label !== undefined && `label ${quote(op.label)}`,
        op.type !== undefined && `type ${typeLabel(op.type)}`,
        op.description !== undefined &&
          (op.description ? `description ${quote(op.description)}` : 'clear description'),
        ...Object.entries(FLAG_WORDS)
          .filter(([k]) => typeof (op as Record<string, unknown>)[k] === 'boolean')
          .map(([k, [yes, no]]) => ((op as Record<string, unknown>)[k] ? yes : no)),
      ].filter(Boolean);
      return `Change ${fld(op.object, op.field)}: ${parts.join(', ') || 'no changes'}`;
    }
    case 'rename_field':
      return `Rename ${fld(op.object, op.field)} to ${op.name}`;
    case 'delete_field':
      return `Delete field ${fld(op.object, op.field)}`;
    case 'add_option':
      return `Add option ${quote(op.option.label || op.option.value)} to ${fld(op.object, op.field)}`;
    case 'update_option':
      return `Rename option ${op.value} of ${fld(op.object, op.field)} to ${quote(op.label)}`;
    case 'remove_option':
      return `Remove option ${op.value} from ${fld(op.object, op.field)}`;
    default:
      return String((op as { op?: unknown }).op ?? 'Unknown change').replaceAll('_', ' ');
  }
}

const DIFF_PROPERTY_WORDS: Record<string, string> = {
  labelSingular: 'singular label',
  labelPlural: 'plural label',
  labelFieldId: 'label field',
  labelField: 'label field',
  label: 'label',
  description: 'description',
};
/**
 * One schema-engine diff operation (the `kind`-keyed form an extension preview
 * and a schema change's `operations` carry) in words. Unknown shapes fall back
 * to the operation kind.
 */
export function describeDiffOp(
  op: { kind: string; [key: string]: unknown },
  objects: ObjectView[],
) {
  const s = (v: unknown) => String(v ?? '');
  const obj = (name: unknown) => objectByName({ objects }, s(name))?.labelSingular ?? s(name);
  const fld = (object: unknown, field: unknown) =>
    `${obj(object)} → ${objectByName({ objects }, s(object))?.fields.find((f) => f.name === s(field))?.label ?? s(field)}`;
  const quote = (v: unknown) => `“${s(v)}”`;
  const named = (v: unknown) => (v ?? {}) as Record<string, unknown>;
  switch (op.kind) {
    case 'create_object': {
      const o = named(op.object);
      return `Add object ${s(o.labelSingular || o.nameSingular)}`;
    }
    case 'update_object':
    case 'update_field': {
      const where = op.kind === 'update_object' ? obj(op.object) : fld(op.object, op.field);
      const flag = FLAG_WORDS[s(op.property)];
      if (flag) return `Change ${where}: ${op.to ? flag[0] : flag[1]}`;
      const what = DIFF_PROPERTY_WORDS[s(op.property)] ?? s(op.property);
      if (op.property === 'labelFieldId') return `Change ${where}: ${what}`;
      if (op.property === 'labelField') return `Change ${where}: ${what} ${s(op.to)}`;
      return `Change ${where}: ${op.to ? `${what} ${quote(op.to)}` : `clear ${what}`}`;
    }
    case 'rename_object':
      return `Rename object ${obj(named(op.from).nameSingular)} to ${s(named(op.to).nameSingular)} / ${s(named(op.to).namePlural)}`;
    case 'deprecate_object':
      return `Delete object ${obj(op.object)}`;
    case 'protect_object':
      return `Protect object ${obj(op.object)}`;
    case 'create_field': {
      const f = named(op.field);
      const type = typeLabel(s(f.type));
      return `Add field ${s(f.label || f.name)} (${type}) to ${obj(op.object)}`;
    }
    case 'rename_field':
      return `Rename ${fld(op.object, op.from)} to ${s(op.to)}`;
    case 'deprecate_field':
      return `Delete field ${fld(op.object, op.field)}`;
    case 'protect_field':
      return `Protect field ${fld(op.object, op.field)}`;
    case 'add_option': {
      const o = named(op.option);
      return `Add option ${quote(o.label || o.value)} to ${fld(op.object, op.field)}`;
    }
    case 'update_option':
      return `Rename option ${s(op.value)} of ${fld(op.object, op.field)} to ${quote(op.to)}`;
    case 'remove_option':
      return `Remove option ${s(op.value)} from ${fld(op.object, op.field)}`;
    default:
      return s(op.kind || 'Unknown change').replaceAll('_', ' ');
  }
}

/** Whether a part of the schema is new, edited or deleted by a change. */
export type ChangeKind = 'added' | 'changed' | 'removed';
/** One property of an object or field, before and after; either side may be absent. */
export type ChangeDetail = { label: string; before?: string; after?: string; code?: boolean };
export type FieldChange = {
  /** The field's universal ID. */
  id: string;
  label: string;
  /** The field type in words, when known. */
  type?: string;
  kind: ChangeKind;
  details: ChangeDetail[];
};
/** Everything one schema change does to one object: its own properties, then its fields. */
export type ObjectChange = {
  /** The object's universal ID. */
  id: string;
  /** The object's API name, for its icon. */
  object: string;
  label: string;
  objectClass: 'entity' | 'event';
  kind: ChangeKind;
  /** Set when the change gives the object a new singular label. */
  rename?: { from: string; to: string };
  details: ChangeDetail[];
  fields: FieldChange[];
};

const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

/**
 * A label with the identifier agents write, when they differ: "In progress
 * (in_progress)", "Name (legalName)".
 */
const named = (label: string | undefined, id: string) =>
  label && label !== id ? `${label} (${id})` : id;

/** A new field's flags in words: "Required · Unique · Searchable". */
function behavior(f: SchemaDiffField) {
  return [
    f.isNullable ? 'Optional' : 'Required',
    f.isUnique && 'Unique',
    f.isFilterable && 'Filterable',
    f.isSearchable && 'Searchable',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A schema change's diff grouped by the object it touches, and within an
 * object by field. The diff is the engine's own net result: objects and
 * fields are matched by universal ID, each property carries its value before
 * and after, and steps that cancel out are already gone. So "Name:
 * Engagement → Project" is exactly what approving does. The server also
 * gives each step the labels to show, found by universal ID, so nothing here
 * matches names against the workspace's schema.
 */
export function groupSchemaDiff(ops: SchemaDiffOperation[]) {
  const groups: ObjectChange[] = [];
  const byId = new Map<string, ObjectChange>();

  type Ref = { objectId: string; object: string; objectLabel: string; objectClass: ObjectClass };
  const group = (ref: Ref) => {
    let g = byId.get(ref.objectId);
    if (!g) {
      g = {
        id: ref.objectId,
        object: ref.object,
        label: ref.objectLabel,
        objectClass: ref.objectClass,
        kind: 'changed',
        details: [],
        fields: [],
      };
      byId.set(ref.objectId, g);
      groups.push(g);
    }
    return g;
  };
  const entry = (
    op: Ref & {
      fieldId: string;
      fieldLabel: string;
      fieldType: FieldType | null;
    },
  ) => {
    const g = group(op);
    let f = g.fields.find((x) => x.id === op.fieldId);
    if (!f) {
      f = { id: op.fieldId, label: op.fieldLabel, kind: 'changed', details: [] };
      if (op.fieldType) f.type = typeLabel(op.fieldType);
      g.fields.push(f);
    }
    return f;
  };
  /** What a new field's settings do: its options, what a relation links to, limits. */
  const settingDetails = (field: SchemaDiffField, targets: DiffTargetLabel[]): ChangeDetail[] => {
    const s = field.settings;
    const details: ChangeDetail[] = [];
    if (s.options?.length)
      details.push({
        label: 'Options',
        after: s.options.map((o) => named(o.label, o.value)).join(', '),
      });
    if (field.type === 'relation' && targets.length) {
      const many =
        s.relationCardinality === 'one_to_many' || s.relationCardinality === 'many_to_many';
      details.push({
        label: 'Links to',
        after: `${many ? 'Many' : 'One'} ${joinOr(targets.map((t) => (many ? t.plural : t.singular)))}`,
      });
    }
    if (s.onDelete)
      details.push({
        label: 'If target is deleted',
        after: s.onDelete === 'cascade' ? 'Delete this record too' : 'Clear this link',
      });
    if (s.rollUpEvents) details.push({ label: 'Rolls up events', after: 'Yes' });
    if (s.maxValues) details.push({ label: 'Most values', after: String(s.maxValues) });
    return details;
  };
  const fieldName = (label: string | null, name: string | null) =>
    name ? named(label ?? undefined, name) : undefined;

  for (const op of ops) {
    switch (op.kind) {
      case 'create_object': {
        const o = op.object;
        const g = group({
          objectId: o.universalId,
          object: o.nameSingular,
          objectLabel: o.labelSingular,
          objectClass: o.class,
        });
        g.kind = 'added';
        g.details.push(
          { label: 'Name', after: o.labelSingular },
          { label: 'Plural name', after: o.labelPlural },
          { label: 'API name', after: `${o.nameSingular} / ${o.namePlural}`, code: true },
        );
        if (o.class === 'event') g.details.push({ label: 'Kind', after: 'Event type' });
        if (o.description) g.details.push({ label: 'Description', after: o.description });
        if (o.labelField)
          g.details.push({
            label: 'Label field',
            after: fieldName(o.labelFieldLabel, o.labelField),
          });
        break;
      }
      case 'update_object': {
        const g = group(op);
        if (op.property === 'labelField') {
          g.details.push({
            label: 'Label field',
            before: fieldName(op.fromLabel, op.from),
            after: fieldName(op.toLabel, op.to),
          });
          break;
        }
        const label = {
          labelSingular: 'Name',
          labelPlural: 'Plural name',
          description: 'Description',
        }[op.property];
        g.details.push({ label, before: op.from || undefined, after: op.to || undefined });
        if (op.property === 'labelSingular' && op.from && op.to)
          g.rename = { from: op.from, to: op.to };
        break;
      }
      case 'rename_object':
        group({ ...op, object: op.to.nameSingular }).details.push({
          label: 'API name',
          before: `${op.from.nameSingular} / ${op.from.namePlural}`,
          after: `${op.to.nameSingular} / ${op.to.namePlural}`,
          code: true,
        });
        break;
      case 'deprecate_object':
        group(op).kind = 'removed';
        break;
      case 'protect_object':
        group(op).details.push({ label: 'Protected', after: 'Yes' });
        break;
      case 'create_field': {
        const field = op.field;
        const f: FieldChange = {
          id: field.universalId,
          label: field.label,
          type: typeLabel(field.type),
          kind: 'added',
          details: [{ label: 'API name', after: field.name, code: true }],
        };
        if (field.description) f.details.push({ label: 'Description', after: field.description });
        f.details.push(
          { label: 'Behavior', after: behavior(field) },
          ...settingDetails(field, op.targetLabels),
        );
        group(op).fields.push(f);
        break;
      }
      case 'update_field': {
        const f = entry(op);
        const flag = FLAGS[op.property];
        if (flag) {
          const word = (v: unknown) =>
            typeof v === 'boolean' ? yesNo(v !== !!flag.inverted) : undefined;
          f.details.push({ label: flag.name, before: word(op.from), after: word(op.to) });
        } else
          f.details.push({
            label: op.property === 'label' ? 'Label' : 'Description',
            before: typeof op.from === 'string' && op.from ? op.from : undefined,
            after: typeof op.to === 'string' && op.to ? op.to : undefined,
          });
        break;
      }
      case 'rename_field':
        entry(op).details.push({ label: 'API name', before: op.from, after: op.to, code: true });
        break;
      case 'deprecate_field':
        entry(op).kind = 'removed';
        break;
      case 'protect_field':
        entry(op).details.push({ label: 'Protected', after: 'Yes' });
        break;
      case 'add_option':
        entry(op).details.push({
          label: 'New option',
          after: named(op.option.label, op.option.value),
        });
        break;
      case 'update_option':
        entry(op).details.push({
          label: 'Option',
          before: named(op.from, op.value),
          after: named(op.to, op.value),
        });
        break;
      case 'remove_option':
        entry(op).details.push({
          label: 'Removed option',
          before: named(op.optionLabel ?? undefined, op.value),
        });
        break;
      default: {
        // A newer server's step: keep it visible, in words.
        const unknown = op as { kind: string };
        group({
          objectId: `unknown:${unknown.kind}`,
          object: '',
          objectLabel: 'Other',
          objectClass: 'entity',
        }).details.push({ label: describeDiffOp(unknown, []) });
      }
    }
  }
  // What the change is about comes first: new types, then types it changes
  // or deletes itself, then those where only fields change (such as the
  // other side of a new relation). Otherwise the engine's order stays.
  const rank = (g: ObjectChange) =>
    g.kind === 'added' ? 0 : g.kind === 'removed' || g.details.length ? 1 : 2;
  return groups.sort((a, b) => rank(a) - rank(b));
}

const lowerFirst = (s: string) => (s ? s[0]?.toLowerCase() + s.slice(1) : s);
/**
 * One line naming what a schema change does, from its grouped form: the
 * object-level moves first ("Rename Engagement to Project"), else each
 * field it touches ("Change Job title on Person"), two at most and a count.
 */
export function summarizeSchemaChange(groups: ObjectChange[]) {
  const phrases = groups.flatMap((g) => {
    if (g.kind === 'added') return [`Add the ${g.label} type`];
    if (g.kind === 'removed') return [`Delete the ${g.label} type`];
    return g.rename ? [`Rename ${g.rename.from} to ${g.rename.to}`] : [];
  });
  if (!phrases.length)
    for (const g of groups) {
      for (const f of g.fields)
        phrases.push(
          f.kind === 'added'
            ? `Add ${f.label} to ${g.label}`
            : f.kind === 'removed'
              ? `Delete ${f.label} from ${g.label}`
              : `Change ${f.label} on ${g.label}`,
        );
      if (!g.fields.length) phrases.push(`Change ${g.label}`);
    }
  const shown = phrases.slice(0, 2).map((p, i) => (i ? lowerFirst(p) : p));
  const rest = phrases.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : joinWords(shown, 'and');
}
