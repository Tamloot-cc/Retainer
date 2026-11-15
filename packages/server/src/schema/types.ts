import type {
  CoreRole,
  FieldType,
  ObjectClass,
  OnDeleteBehavior,
  RelationCardinality,
  SchemaOwner,
  SchemaStatus,
  SelectOption,
} from '@retainer/shared';

/**
 * Field settings as stored in `fields.settings`. Relations point at objects
 * and fields by universal ID, so renaming either never breaks a relation.
 * The API presents them by name (see present.ts).
 */
export type StoredFieldSettings = {
  options?: SelectOption[];
  /** `relation`: universal ID of the object on the other side. */
  targetObjectId?: string;
  /**
   * `relation`, polymorphic: universal IDs of the two or more objects it may
   * point at, instead of `targetObjectId`.
   */
  targetObjectIds?: string[];
  /** `relation`: universal ID of the field on the other side. */
  inverseFieldId?: string;
  relationCardinality?: RelationCardinality;
  /** Set by the engine on the derived, read-only side of a relation. */
  isInverse?: boolean;
  onDelete?: OnDeleteBehavior;
  /** Owning relation of an entity: attached events roll up to the target (7.2). */
  rollUpEvents?: boolean;
  maxValues?: number;
};

export type FieldState = {
  /** Database ID; absent until the field is persisted. */
  id?: string;
  universalId: string;
  key: string;
  name: string;
  label: string;
  description: string | null;
  type: FieldType;
  settings: StoredFieldSettings;
  isNullable: boolean;
  isUnique: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  /** Set by the engine for fields server code depends on (protection.ts). */
  isProtected: boolean;
  /** An event type's core field; set by the engine, never by a client. */
  coreRole: CoreRole | null;
  owner: SchemaOwner;
  status: SchemaStatus;
};

export type ObjectState = {
  id?: string;
  universalId: string;
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  /** Universal ID of the label field. */
  labelFieldId: string | null;
  /** Field universal ID, null to disable, or 'default' to use the built-in source. */
  avatarFieldId: string | null;
  /** Set by the engine for objects server code depends on (protection.ts). */
  isProtected: boolean;
  /** `entity` or `event`; fixed when the object is created. */
  class: ObjectClass;
  owner: SchemaOwner;
  status: SchemaStatus;
  /** Every field, deprecated ones included, so keys are never reused. */
  fields: FieldState[];
};

/** A workspace's whole schema, deprecated rows included. */
export type SchemaState = {
  objects: ObjectState[];
};

export type ObjectProps = Omit<ObjectState, 'id' | 'fields' | 'status'>;
export type FieldProps = Omit<FieldState, 'id' | 'status'>;

/** An operation produced by the diff; this is what gets classified and persisted. */
export type DiffOp =
  | { kind: 'create_object'; object: ObjectProps }
  | {
      kind: 'update_object';
      objectId: string;
      object: string;
      property: 'labelSingular' | 'labelPlural' | 'description' | 'labelFieldId' | 'avatarFieldId';
      from: string | null;
      to: string | null;
    }
  | {
      kind: 'rename_object';
      objectId: string;
      from: { nameSingular: string; namePlural: string };
      to: { nameSingular: string; namePlural: string };
    }
  | { kind: 'deprecate_object'; objectId: string; object: string }
  /** Trusted path only: the engine protects an element server code depends on. */
  | { kind: 'protect_object'; objectId: string; object: string }
  | { kind: 'create_field'; objectId: string; object: string; field: FieldProps }
  | {
      kind: 'update_field';
      objectId: string;
      object: string;
      fieldId: string;
      field: string;
      property:
        | 'label'
        | 'description'
        | 'isNullable'
        | 'isUnique'
        | 'isFilterable'
        | 'isSearchable'
        | 'rollUpEvents';
      from: string | boolean | null;
      to: string | boolean | null;
    }
  | {
      kind: 'rename_field';
      objectId: string;
      object: string;
      fieldId: string;
      from: string;
      to: string;
    }
  | { kind: 'deprecate_field'; objectId: string; object: string; fieldId: string; field: string }
  | { kind: 'protect_field'; objectId: string; object: string; fieldId: string; field: string }
  | {
      kind: 'add_option';
      objectId: string;
      object: string;
      fieldId: string;
      field: string;
      option: SelectOption;
    }
  | {
      kind: 'update_option';
      objectId: string;
      object: string;
      fieldId: string;
      field: string;
      value: string;
      from: string;
      to: string;
    }
  | {
      kind: 'remove_option';
      objectId: string;
      object: string;
      fieldId: string;
      field: string;
      value: string;
    };

export type Classification = 'additive' | 'destructive';

/** One problem found while applying or validating a change. */
export type SchemaIssue = {
  /** Where the problem is, e.g. "person.emails" or "deal". */
  path: string;
  message: string;
};

export class SchemaValidationError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'SchemaValidationError';
  }
}

/** The universal IDs of the objects a relation may point at. */
export function relationTargetIds(settings: StoredFieldSettings): string[] {
  return settings.targetObjectIds ?? (settings.targetObjectId ? [settings.targetObjectId] : []);
}
