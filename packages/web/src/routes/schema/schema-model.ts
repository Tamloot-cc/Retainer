import {
  type FieldDefinition,
  type FieldView,
  isInverseRelation,
  type ObjectView,
  relationTargets,
  SCHEMA_CHANGE_STATUSES,
  type SchemaChangeStatus,
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
  /** The field's API name, which identifies it within the change. */
  name: string;
  label: string;
  /** The field type in words, when known. */
  type?: string;
  kind: ChangeKind;
  details: ChangeDetail[];
};
/** Everything one schema change does to one object: its own properties, then its fields. */
export type ObjectChange = {
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
const text = (v: string | null | undefined) => (v ? v : undefined);

/**
 * A schema change's operations grouped by the object they touch, and within
 * an object by field, in the order they first appear. Each property shows
 * what it is now (from the current schema) and what the change makes it, so
 * a reviewer sees "Name: Engagement → Project" instead of reading one
 * sentence per operation.
 */
export function groupSchemaChange(request: SchemaOperation[], objects: ObjectView[]) {
  const groups: ObjectChange[] = [];
  const byName = new Map(objects.map((o) => [o.nameSingular, o]));
  const current = (name: string) => byName.get(name);
  const group = (name: string) => {
    let g = groups.find((x) => x.object === name);
    if (!g) {
      const o = current(name);
      g = {
        object: name,
        label: o?.labelSingular ?? name,
        objectClass: o?.class ?? 'entity',
        kind: 'changed',
        details: [],
        fields: [],
      };
      groups.push(g);
    }
    return g;
  };
  const field = (object: string, name: string, kind: ChangeKind = 'changed') => {
    const g = group(object);
    let f = g.fields.find((x) => x.name === name);
    if (!f) {
      const view = current(object)?.fields.find((x) => x.name === name);
      f = {
        name,
        label: view?.label ?? name,
        type: view && typeLabel(view.type),
        kind,
        details: [],
      };
      g.fields.push(f);
    } else if (kind !== 'changed') f.kind = kind;
    return f;
  };
  const added = (object: string, def: FieldDefinition) => {
    const f = field(object, def.name, 'added');
    f.label = def.label || def.name;
    f.type = typeLabel(def.type);
    if (def.description) f.details.push({ label: 'Description', after: def.description });
    if (def.isNullable === false) f.details.push({ label: 'Required', after: 'Yes' });
    if (def.isUnique) f.details.push({ label: 'Unique', after: 'Yes' });
  };
  const option = (object: string, fieldName: string, value: string) =>
    current(object)
      ?.fields.find((x) => x.name === fieldName)
      ?.settings.options?.find((o) => o.value === value)?.label ?? value;

  // The engine applies operations in order, so after a rename later ones
  // name the part by its new name. Map those back to the current schema's
  // names, so one object or field stays one entry.
  const objectAlias = new Map<string, string>();
  const fieldAlias = new Map<string, string>();
  const resolve = (raw: SchemaOperation): SchemaOperation => {
    if (raw.op === 'create_object') return raw;
    const object = objectAlias.get(raw.object) ?? raw.object;
    if (raw.op === 'create_field' || !('field' in raw)) return { ...raw, object };
    return { ...raw, object, field: fieldAlias.get(`${object}.${raw.field}`) ?? raw.field };
  };

  for (const raw of request) {
    const op = resolve(raw);
    switch (op.op) {
      case 'create_object': {
        const g = group(op.object.nameSingular);
        g.kind = 'added';
        g.label = op.object.labelSingular || op.object.nameSingular;
        g.objectClass = op.object.class ?? 'entity';
        g.details.push(
          { label: 'Name', after: op.object.labelSingular },
          { label: 'Plural name', after: op.object.labelPlural },
          { label: 'API name', after: op.object.nameSingular, code: true },
        );
        if (op.object.description)
          g.details.push({ label: 'Description', after: op.object.description });
        for (const def of op.object.fields ?? []) added(op.object.nameSingular, def);
        break;
      }
      case 'update_object': {
        const g = group(op.object),
          o = current(op.object);
        const fieldLabel = (name: string | null | undefined) =>
          name ? (o?.fields.find((f) => f.name === name)?.label ?? name) : undefined;
        if (op.labelSingular !== undefined) {
          g.details.push({ label: 'Name', before: o?.labelSingular, after: op.labelSingular });
          if (o && o.labelSingular !== op.labelSingular)
            g.rename = { from: o.labelSingular, to: op.labelSingular };
        }
        if (op.labelPlural !== undefined)
          g.details.push({ label: 'Plural name', before: o?.labelPlural, after: op.labelPlural });
        if (op.labelField !== undefined)
          g.details.push({
            label: 'Label field',
            before: fieldLabel(o?.labelField),
            after: fieldLabel(op.labelField),
          });
        if (op.description !== undefined)
          g.details.push({
            label: 'Description',
            before: text(o?.description),
            after: text(op.description),
          });
        break;
      }
      case 'rename_object': {
        const o = current(op.object);
        const named = raw.op === 'rename_object' ? raw.object : op.object;
        group(op.object).details.push({
          label: 'API name',
          before: o && named === o.nameSingular ? `${o.nameSingular} / ${o.namePlural}` : named,
          after: `${op.nameSingular} / ${op.namePlural}`,
          code: true,
        });
        objectAlias.set(op.nameSingular, op.object);
        break;
      }
      case 'delete_object':
        group(op.object).kind = 'removed';
        break;
      case 'create_field':
        added(op.object, op.field);
        break;
      case 'update_field': {
        const f = field(op.object, op.field),
          view = current(op.object)?.fields.find((x) => x.name === op.field);
        if (op.label !== undefined)
          f.details.push({ label: 'Label', before: view?.label, after: op.label });
        if (op.type !== undefined)
          f.details.push({
            label: 'Type',
            before: view && typeLabel(view.type),
            after: typeLabel(op.type),
          });
        if (op.description !== undefined)
          f.details.push({
            label: 'Description',
            before: text(view?.description),
            after: text(op.description),
          });
        for (const [key, flag] of Object.entries(FLAGS)) {
          const to = (op as Record<string, unknown>)[key];
          if (typeof to !== 'boolean') continue;
          const from = view
            ? Boolean(
                key === 'rollUpEvents' ? view.settings.rollUpEvents : view[key as keyof FieldView],
              )
            : undefined;
          f.details.push({
            label: flag.name,
            before: from === undefined ? undefined : yesNo(from !== !!flag.inverted),
            after: yesNo(to !== !!flag.inverted),
          });
        }
        break;
      }
      case 'rename_field':
        field(op.object, op.field).details.push({
          label: 'API name',
          // The name it had at this point in the request.
          before: raw.op === 'rename_field' ? raw.field : op.field,
          after: op.name,
          code: true,
        });
        fieldAlias.set(`${op.object}.${op.name}`, op.field);
        break;
      case 'delete_field':
        field(op.object, op.field, 'removed');
        break;
      case 'add_option':
        field(op.object, op.field).details.push({
          label: 'New option',
          after: op.option.label || op.option.value,
        });
        break;
      case 'update_option':
        field(op.object, op.field).details.push({
          label: 'Option',
          before: option(op.object, op.field, op.value),
          after: op.label,
        });
        break;
      case 'remove_option':
        field(op.object, op.field).details.push({
          label: 'Removed option',
          before: option(op.object, op.field, op.value),
        });
        break;
      default: {
        // A newer server's operation: keep it visible, in words.
        const unknown = op as { object?: unknown };
        group(typeof unknown.object === 'string' ? unknown.object : '').details.push({
          label: describeOperation(op, objects),
        });
      }
    }
  }
  return groups;
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
