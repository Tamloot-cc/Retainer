import {
  HIDDEN_TYPE_IDS,
  INTERNAL_NOTE_TYPE_ID,
  MEMBER_PROFILE_TYPE_ID,
  type ProfileAlias,
  WORKSPACE_PROFILE_TYPE_ID,
} from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { loadSchemaState } from './load.js';
import type { FieldState, ObjectState, SchemaState } from './types.js';

/** One object with lookups the record code needs. */
export type CompiledObject = {
  state: ObjectState;
  id: string;
  name: string;
  /** Active fields by API name. */
  fieldsByName: Map<string, FieldState>;
  /** Every field, deprecated included, by database ID. */
  fieldsById: Map<string, FieldState>;
  /** Active fields in definition order. */
  activeFields: FieldState[];
  labelField: FieldState | undefined;
  /** An event type: its records carry `event_records` and links (1.3). */
  isEvent: boolean;
  /**
   * The internal-note type (6.4) and the profile types (personal memory
   * spec 4.1). Hidden objects are left out of `objectsByName`, so every
   * route that resolves an object by name treats them as absent; record
   * routes check `hidden` through `objectOf`.
   */
  hidden: boolean;
  /** For a profile type, the alias agents name its records with. */
  profile?: ProfileAlias;
  /** Event types only: the core fields, found by role, never by name. */
  core?: { title: FieldState; summary: FieldState };
};

/** A workspace schema at one `schema_version`, ready for validation and reads. */
export type CompiledSchema = {
  version: number;
  state: SchemaState;
  /** Active objects by singular API name. */
  objectsByName: Map<string, CompiledObject>;
  /** Every object by database ID. */
  objectsById: Map<string, CompiledObject>;
  /** Every object by universal ID. */
  objectsByUniversalId: Map<string, CompiledObject>;
  /** Every field, by database ID, with its object. */
  fieldOwners: Map<string, CompiledObject>;
  /** IDs of active objects that are not hidden: what reads may show. */
  visibleObjectIds: string[];
  /** IDs of active, visible event types. */
  eventTypeIds: string[];
  /** IDs of active, visible entity objects: the visible objects that are not events. */
  entityTypeIds: string[];
  /** Owning relation fields of active event types: each attaches its event (6.3). */
  eventRelationFieldIds: string[];
  /** Owning relation fields of active entities with `rollUpEvents` on (7.2). */
  rollUpFieldIds: string[];
  /** The hidden internal-note type, once seeded. */
  internalNote: CompiledObject | undefined;
  /** The hidden profile types (personal memory spec 4.1), once seeded. */
  workspaceProfile: CompiledObject | undefined;
  memberProfile: CompiledObject | undefined;
};

export function compileSchema(state: SchemaState, version: number): CompiledSchema {
  const compiled: CompiledSchema = {
    version,
    state,
    objectsByName: new Map(),
    objectsById: new Map(),
    objectsByUniversalId: new Map(),
    fieldOwners: new Map(),
    visibleObjectIds: [],
    eventTypeIds: [],
    entityTypeIds: [],
    eventRelationFieldIds: [],
    rollUpFieldIds: [],
    internalNote: undefined,
    workspaceProfile: undefined,
    memberProfile: undefined,
  };
  for (const object of state.objects) {
    if (!object.id) throw new Error('compileSchema needs a persisted schema');
    const activeFields = object.fields.filter((f) => f.status === 'active');
    const hidden = HIDDEN_TYPE_IDS.has(object.universalId);
    const profile =
      object.universalId === WORKSPACE_PROFILE_TYPE_ID
        ? ('workspace' as const)
        : object.universalId === MEMBER_PROFILE_TYPE_ID
          ? ('me' as const)
          : undefined;
    const isEvent = object.class === 'event';
    const title = activeFields.find((f) => f.coreRole === 'title');
    const summary = activeFields.find((f) => f.coreRole === 'summary');
    const entry: CompiledObject = {
      state: object,
      id: object.id,
      name: object.nameSingular,
      fieldsByName: new Map(activeFields.map((f) => [f.name, f])),
      fieldsById: new Map(object.fields.map((f) => [f.id as string, f])),
      activeFields,
      labelField: object.fields.find((f) => f.universalId === object.labelFieldId),
      isEvent,
      hidden,
      ...(profile ? { profile } : {}),
      ...(isEvent && title && summary ? { core: { title, summary } } : {}),
    };
    if (object.status === 'active' && !hidden) {
      compiled.objectsByName.set(object.nameSingular, entry);
      compiled.visibleObjectIds.push(object.id);
      (isEvent ? compiled.eventTypeIds : compiled.entityTypeIds).push(object.id);
      for (const field of activeFields) {
        if (field.type !== 'relation' || field.settings.isInverse) continue;
        if (isEvent) compiled.eventRelationFieldIds.push(field.id as string);
        else if (field.settings.rollUpEvents) compiled.rollUpFieldIds.push(field.id as string);
      }
    }
    if (object.universalId === INTERNAL_NOTE_TYPE_ID) compiled.internalNote = entry;
    if (profile === 'workspace') compiled.workspaceProfile = entry;
    if (profile === 'me') compiled.memberProfile = entry;
    compiled.objectsById.set(object.id, entry);
    compiled.objectsByUniversalId.set(object.universalId, entry);
    for (const field of object.fields) compiled.fieldOwners.set(field.id as string, entry);
  }
  return compiled;
}

/** An active, visible object by singular or plural API name. */
export function objectNamed(schema: CompiledSchema, name: string): CompiledObject | undefined {
  return (
    schema.objectsByName.get(name) ??
    [...schema.objectsByName.values()].find((o) => o.state.namePlural === name)
  );
}

/** An event's core title and summary (6.1), found by role; null when not text. */
export function eventText(
  object: CompiledObject | undefined,
  data: Record<string, unknown>,
): { title: string | null; summary: string | null } {
  const text = (field: FieldState | undefined) => {
    const value = field ? data[field.key] : undefined;
    return typeof value === 'string' ? value : null;
  };
  return { title: text(object?.core?.title), summary: text(object?.core?.summary) };
}

/**
 * Compiled schemas cached per (workspace, schema_version). Every applied
 * change increments the version, so a cached entry never goes stale; old
 * versions are dropped when a newer one is loaded.
 */
const cache = new Map<string, CompiledSchema>();

/**
 * The workspace's current schema. Call it after taking the schema lock, so
 * the version read here stays current for the rest of the transaction.
 */
export async function getSchema(tx: Tx, workspaceId: string): Promise<CompiledSchema> {
  const [workspace] = await tx<{ schema_version: number }[]>`
    select schema_version from workspaces where id = ${workspaceId}`;
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const cached = cache.get(workspaceId);
  if (cached && cached.version === workspace.schema_version) return cached;
  const compiled = compileSchema(await loadSchemaState(tx, workspaceId), workspace.schema_version);
  cache.set(workspaceId, compiled);
  return compiled;
}
