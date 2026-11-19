import type {
  Classification,
  DiffOp,
  FieldProps,
  FieldState,
  ObjectProps,
  ObjectState,
  SchemaState,
} from '../schema/types.js';

function objectProps({
  id: _id,
  fields: _fields,
  status: _status,
  ...props
}: ObjectState): ObjectProps {
  return props;
}

function fieldProps({ id: _id, status: _status, ...props }: FieldState): FieldProps {
  return props;
}

const OBJECT_PROPERTIES = ['labelSingular', 'labelPlural', 'description', 'labelFieldId'] as const;
const FIELD_PROPERTIES = [
  'label',
  'description',
  'isNullable',
  'isUnique',
  'isFilterable',
  'isSearchable',
] as const;

/**
 * Step 4 of the engine: the operations that turn `current` into `desired`.
 * Objects and fields are matched by universal ID, so a rename shows up as a
 * rename rather than a delete and a create. Each property change is its own
 * operation, which keeps classification per change.
 */
export function diffSchemas(current: SchemaState, desired: SchemaState): DiffOp[] {
  const ops: DiffOp[] = [];
  const currentObjects = new Map(current.objects.map((o) => [o.universalId, o]));

  for (const object of desired.objects) {
    const before = currentObjects.get(object.universalId);
    const objectId = object.universalId;
    const name = object.nameSingular;

    if (!before) {
      if (object.status !== 'active') continue;
      ops.push({ kind: 'create_object', object: objectProps(object) });
      for (const field of object.fields) {
        if (field.status === 'active') {
          ops.push({ kind: 'create_field', objectId, object: name, field: fieldProps(field) });
        }
      }
      continue;
    }
    if (before.status !== 'active') continue;
    if (object.status !== 'active') {
      ops.push({ kind: 'deprecate_object', objectId, object: before.nameSingular });
      continue;
    }

    if (before.nameSingular !== object.nameSingular || before.namePlural !== object.namePlural) {
      ops.push({
        kind: 'rename_object',
        objectId,
        from: { nameSingular: before.nameSingular, namePlural: before.namePlural },
        to: { nameSingular: object.nameSingular, namePlural: object.namePlural },
      });
    }
    for (const property of OBJECT_PROPERTIES) {
      if (before[property] !== object[property]) {
        ops.push({
          kind: 'update_object',
          objectId,
          object: name,
          property,
          from: before[property],
          to: object[property],
        });
      }
    }

    const currentFields = new Map(before.fields.map((f) => [f.universalId, f]));
    for (const field of object.fields) {
      const previous = currentFields.get(field.universalId);
      if (!previous) {
        if (field.status === 'active') {
          ops.push({ kind: 'create_field', objectId, object: name, field: fieldProps(field) });
        }
        continue;
      }
      if (previous.status !== 'active') continue;
      const fieldId = field.universalId;
      if (field.status !== 'active') {
        ops.push({
          kind: 'deprecate_field',
          objectId,
          object: name,
          fieldId,
          field: previous.name,
        });
        continue;
      }
      if (previous.name !== field.name) {
        ops.push({
          kind: 'rename_field',
          objectId,
          object: name,
          fieldId,
          from: previous.name,
          to: field.name,
        });
      }
      for (const property of FIELD_PROPERTIES) {
        if (previous[property] !== field[property]) {
          ops.push({
            kind: 'update_field',
            objectId,
            object: name,
            fieldId,
            field: field.name,
            property,
            from: previous[property],
            to: field[property],
          });
        }
      }

      const rollUp = (f: FieldState) => f.settings.rollUpEvents === true;
      if (rollUp(previous) !== rollUp(field)) {
        ops.push({
          kind: 'update_field',
          objectId,
          object: name,
          fieldId,
          field: field.name,
          property: 'rollUpEvents',
          from: rollUp(previous),
          to: rollUp(field),
        });
      }

      const before = new Map((previous.settings.options ?? []).map((o) => [o.value, o.label]));
      const after = new Map((field.settings.options ?? []).map((o) => [o.value, o.label]));
      const base = { objectId, object: name, fieldId, field: field.name };
      for (const [value, label] of after) {
        const old = before.get(value);
        if (old === undefined) ops.push({ kind: 'add_option', ...base, option: { value, label } });
        else if (old !== label)
          ops.push({ kind: 'update_option', ...base, value, from: old, to: label });
      }
      for (const [value, label] of before) {
        if (!after.has(value)) ops.push({ kind: 'remove_option', ...base, value, label });
      }
    }
  }

  // Protection only changes on the engine's trusted path, for any status.
  for (const object of desired.objects) {
    const before = currentObjects.get(object.universalId);
    if (!before) continue;
    const objectId = object.universalId;
    if (object.isProtected && !before.isProtected) {
      ops.push({ kind: 'protect_object', objectId, object: object.nameSingular });
    }
    const currentFields = new Map(before.fields.map((f) => [f.universalId, f]));
    for (const field of object.fields) {
      if (field.isProtected && currentFields.get(field.universalId)?.isProtected === false) {
        ops.push({
          kind: 'protect_field',
          objectId,
          object: object.nameSingular,
          fieldId: field.universalId,
          field: field.name,
        });
      }
    }
  }

  return ops;
}

/**
 * Step 5: additive operations apply automatically; destructive ones need a
 * human. Anything not listed as additive in ARCHITECTURE.md 3 is
 * destructive, including adding a required or unique field.
 */
export function classifyOp(op: DiffOp): Classification {
  switch (op.kind) {
    case 'create_object':
    case 'update_object':
    case 'add_option':
    case 'update_option':
    // Protection restricts later changes and touches no data.
    case 'protect_object':
    case 'protect_field':
      return 'additive';
    case 'create_field':
      return op.field.isUnique || !op.field.isNullable ? 'destructive' : 'additive';
    case 'update_field':
      if (op.property === 'label' || op.property === 'description') return 'additive';
      // A rollup is read-time: nothing is stored, so either direction is safe (7.2).
      if (op.property === 'rollUpEvents') return 'additive';
      if ((op.property === 'isFilterable' || op.property === 'isSearchable') && op.to === true) {
        return 'additive';
      }
      return 'destructive';
    case 'rename_object':
    case 'deprecate_object':
    case 'rename_field':
    case 'deprecate_field':
    case 'remove_option':
      return 'destructive';
  }
}

export function isDestructive(ops: DiffOp[]): boolean {
  return ops.some((op) => classifyOp(op) === 'destructive');
}
