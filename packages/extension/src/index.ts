import { nextOccurrence } from './cron.js';
import { SYSTEM_LIFECYCLE_FUNCTION_ID } from './protocol.js';
import { verifierHeaderAllowed } from './webhook.js';

export { nextOccurrence } from './cron.js';

import { FIELD_TYPES } from '@retainer/shared';
import { z } from 'zod';

const uuid = z.uuid();
const name = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,99}$/);
const label = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const field = z.strictObject({
  universalId: uuid,
  name,
  label,
  type: z.enum(FIELD_TYPES),
  description: z.string().max(2000).optional(),
  isNullable: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  settings: z
    .strictObject({
      options: z
        .array(z.strictObject({ value: label, label }))
        .max(200)
        .optional(),
      targetObject: uuid.optional(),
      targetObjects: z.array(uuid).max(20).optional(),
      relationCardinality: z.enum(['many_to_one', 'many_to_many']).optional(),
      onDelete: z.enum(['set_null', 'cascade']).optional(),
      rollUpEvents: z.boolean().optional(),
      maxValues: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
});
const object = z.strictObject({
  universalId: uuid,
  nameSingular: name,
  namePlural: name,
  labelSingular: label,
  labelPlural: label,
  class: z.enum(['entity', 'event']).optional(),
  description: z.string().max(2000).optional(),
  labelField: name.optional(),
  fields: z.array(field).max(200),
});
export const contributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('object'), definition: object }),
  z.strictObject({ kind: z.literal('field'), objectId: uuid, definition: field }),
]);

// A deliberately small JSON Schema subset. No refs, arbitrary keywords or executable defaults.
export type InputSchema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: InputSchema;
  maxLength?: number;
  maxItems?: number;
};
const inputSchema: z.ZodType<InputSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']),
    properties: z.record(name, inputSchema).optional(),
    required: z.array(name).max(100).optional(),
    additionalProperties: z.literal(false).optional(),
    items: inputSchema.optional(),
    maxLength: z.number().int().min(1).max(65536).optional(),
    maxItems: z.number().int().min(1).max(1000).optional(),
  }),
);
const trigger = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('install') }),
  z.strictObject({ kind: z.literal('uninstall') }),
  z.strictObject({ kind: z.literal('job') }),
  z.strictObject({ kind: z.literal('route'), route: name }),
  z.strictObject({ kind: z.literal('serverRoute'), route: name }),
  z.strictObject({
    kind: z.literal('schedule'),
    cron: z.string().min(9).max(100),
    timezone: z.literal('UTC'),
  }),
  z.strictObject({ kind: z.literal('change'), objectId: uuid, fieldIds: z.array(uuid).max(200) }),
]);
export const functionSchema = z.strictObject({
  universalId: uuid,
  name,
  description: z.string().min(1).max(2000),
  handlerDigest: digest,
  trigger,
  inputSchema,
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
});
export const viewSchema = z.strictObject({
  universalId: uuid,
  objectId: uuid,
  name: label,
  kind: z.literal('table'),
  fieldIds: z.array(uuid).max(200),
});
export const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  universalId: uuid,
  name,
  version,
  description: z.string().min(1).max(2000),
  packageDigest: digest,
  // Exact compatible versions in the first contract; range evaluation belongs to the release builder.
  serverVersions: z.array(version).min(1).max(100),
  runtimeVersion: z.literal('node24'),
  execution: z.enum(['hosted', 'standalone']),
  /** Reviewed first-party OAuth client identity, pinned into the release digest. */
  oauthClientId: z.string().min(1).max(2048).regex(/^\S+$/).optional(),
  protocolVersion: z.literal(1),
  requestedActor: z.enum(['integration', 'agent']),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .max(2),
  connection: z.literal('workspace'),
  createPeople: z.enum(['never', 'contacted_first', 'everyone']),
  onSourceDelete: z.enum(['keep', 'retract']),
  /** Narrow server-computed derivation; only these functions may replace their own derived claims. */
  lastContact: z
    .strictObject({
      functionIds: z.array(uuid).min(1).max(20),
      fields: z
        .array(z.strictObject({ objectId: uuid, fieldId: uuid }))
        .min(1)
        .max(20),
    })
    .optional(),
  /** Reviewed, release-pinned ingestion authority; provider code attests only through setup. */
  source: z
    .strictObject({
      provider: name,
      identity: z.enum(['account', 'global-resource']),
      verifyFunctionId: uuid,
      syncFunctionIds: z.array(uuid).min(1).max(20),
      scanFunctionIds: z.array(uuid).min(1).max(20).optional(),
      eventTypeIds: z.array(uuid).min(1).max(20),
      revisionOrder: z.enum(['integer', 'timestamp', 'opaque']),
    })
    .optional(),
  /** Release-owned ingress contracts; workspace settings cannot choose verifiers or job functions. */
  webhooks: z
    .array(
      z.strictObject({
        route: name,
        verifierFunctionId: uuid,
        syncFunctionId: uuid,
        secretSetting: name,
        headers: z.array(z.string().refine(verifierHeaderAllowed)).min(1).max(20),
        accountHeader: z
          .string()
          .regex(/^[a-z0-9-]{1,100}$/)
          .optional(),
        challenge: z.boolean().optional(),
        optional: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  settings: z.record(
    name,
    z.strictObject({
      type: z.enum(['string', 'boolean', 'number']),
      label,
      description: z.string().max(2000).optional(),
      secret: z.boolean().default(false),
      /** Provider-generated secret, writable only by admitted runs; never an admin form input. */
      generated: z.boolean().optional(),
      reconnect: z.boolean().default(false),
      required: z.boolean().default(false),
      /** Form defaults only; approval requests still carry explicit non-secret values. */
      default: z.union([z.string(), z.boolean(), z.number().finite()]).optional(),
      options: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
      /** Explicit sharing acknowledgement; the server refuses false in a preview or commit. */
      consent: z.boolean().optional(),
    }),
  ),
  schema: z.array(contributionSchema).max(500),
  views: z.array(viewSchema).max(100),
  functions: z.array(functionSchema).max(100),
});
export type ExtensionManifest = z.infer<typeof manifestSchema>;
export type SchemaContribution = z.infer<typeof contributionSchema>;

/** Bound traversal before recursive parsing (including objects received directly by build tools). */
function bounded(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 20) throw new Error('unsupported_manifest: maximum nesting is 20');
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('unsupported_manifest: cyclic input');
    seen.add(value);
    for (const child of Object.values(value)) bounded(child, depth + 1, seen);
    seen.delete(value);
  } else if (
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new Error('unsupported_manifest: JSON values required');
  }
}
function checkInput(schema: InputSchema): void {
  if (
    schema.type !== 'object' &&
    (schema.properties || schema.required || schema.additionalProperties !== undefined)
  )
    throw new Error('unsupported_manifest: object keywords require object type');
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false)
      throw new Error('unsupported_manifest: object inputs must reject additional properties');
    if (
      new Set(schema.required).size !== (schema.required?.length ?? 0) ||
      schema.required?.some((key) => !Object.hasOwn(schema.properties ?? {}, key))
    )
      throw new Error('unsupported_manifest: required properties must exist and be unique');
    for (const property of Object.values(schema.properties ?? {})) checkInput(property);
  }
  if (schema.type === 'array') {
    if (!schema.items || !schema.maxItems)
      throw new Error('unsupported_manifest: arrays need bounded items');
    checkInput(schema.items);
  } else if (schema.items || schema.maxItems !== undefined) {
    throw new Error('unsupported_manifest: array keywords require array type');
  }
  if (schema.maxLength !== undefined && schema.type !== 'string')
    throw new Error('unsupported_manifest: maxLength requires string type');
}
function checkFunction(fn: z.infer<typeof functionSchema>) {
  checkInput(fn.inputSchema);
  if (fn.trigger.kind === 'change') {
    const input = fn.inputSchema;
    if (
      input.type !== 'object' ||
      input.additionalProperties !== false ||
      input.required?.length !== 1 ||
      input.required[0] !== 'changePosition' ||
      Object.keys(input.properties ?? {}).length !== 1 ||
      input.properties?.changePosition?.type !== 'string' ||
      input.properties.changePosition.maxLength !== 19
    )
      throw new Error('unsupported_manifest: change handlers accept only a local changePosition');
    if (new Set(fn.trigger.fieldIds).size !== fn.trigger.fieldIds.length)
      throw new Error('unsupported_manifest: duplicate watched field');
  }
  if (fn.trigger.kind === 'schedule') {
    const input = fn.inputSchema;
    if (
      input.type !== 'object' ||
      input.additionalProperties !== false ||
      input.required?.length !== 1 ||
      input.required[0] !== 'scheduledAt' ||
      Object.keys(input.properties ?? {}).length !== 1 ||
      input.properties?.scheduledAt?.type !== 'string' ||
      (input.properties.scheduledAt.maxLength !== undefined &&
        input.properties.scheduledAt.maxLength < 24)
    )
      throw new Error('unsupported_manifest: schedule handlers accept only a UTC scheduledAt');
    nextOccurrence(fn.trigger.cron, new Date('2000-01-01T00:00:00Z'));
  }
}
export function defineExtension(value: unknown): ExtensionManifest {
  bounded(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576)
    throw new Error('unsupported_manifest: maximum size is 1 MiB');
  const manifest = manifestSchema.parse(value);
  const ids = [
    manifest.universalId,
    ...manifest.functions.map((f) => f.universalId),
    ...manifest.views.map((v) => v.universalId),
    ...manifest.schema.flatMap((s) =>
      s.kind === 'object'
        ? [s.definition.universalId, ...s.definition.fields.map((f) => f.universalId)]
        : [s.definition.universalId],
    ),
  ];
  if (manifest.functions.some((fn) => fn.universalId === SYSTEM_LIFECYCLE_FUNCTION_ID))
    throw new Error('unsupported_manifest: reserved lifecycle function ID');
  if (new Set(ids).size !== ids.length)
    throw new Error('unsupported_manifest: duplicate universal ID');
  if (new Set(manifest.scopes).size !== manifest.scopes.length)
    throw new Error('unsupported_manifest: duplicate scope');
  if (manifest.oauthClientId && manifest.execution !== 'standalone')
    throw new Error('unsupported_manifest: OAuth clients require standalone execution');
  if (manifest.execution === 'standalone' && manifest.functions.length)
    throw new Error('unsupported_manifest: standalone apps cannot contain hosted functions');
  for (const setting of Object.values(manifest.settings))
    if (setting.generated && (!setting.secret || setting.required))
      throw new Error('unsupported_manifest: generated secrets must be optional secret settings');
  for (const setting of Object.values(manifest.settings)) {
    if (
      (setting.default !== undefined &&
        (setting.secret || typeof setting.default !== setting.type)) ||
      (setting.options &&
        (setting.secret ||
          setting.type !== 'string' ||
          new Set(setting.options).size !== setting.options.length ||
          (setting.default !== undefined && !setting.options.includes(String(setting.default))))) ||
      (setting.consent &&
        (setting.secret ||
          setting.type !== 'boolean' ||
          !setting.required ||
          setting.default === true))
    )
      throw new Error('unsupported_manifest: invalid setting default, choices or consent');
  }
  if (manifest.lastContact) {
    const policy = manifest.lastContact;
    if (
      manifest.execution !== 'hosted' ||
      !manifest.scopes.includes('read') ||
      !manifest.scopes.includes('write') ||
      new Set(policy.functionIds).size !== policy.functionIds.length ||
      new Set(policy.fields.map((entry) => entry.objectId)).size !== policy.fields.length ||
      policy.functionIds.some(
        (id) =>
          !manifest.functions.some(
            (fn) =>
              fn.universalId === id && ['job', 'change', 'schedule'].includes(fn.trigger.kind),
          ),
      ) ||
      policy.fields.some(
        (entry) =>
          !manifest.schema.some(
            (item) =>
              item.kind === 'field' &&
              item.objectId === entry.objectId &&
              item.definition.universalId === entry.fieldId &&
              item.definition.type === 'date_time' &&
              item.definition.isNullable !== false &&
              item.definition.isUnique !== true,
          ),
      )
    )
      throw new Error(
        'unsupported_manifest: last-contact requires owned nullable date-time fields and pinned runtime functions',
      );
  }
  const hookRoutes = new Set<string>();
  for (const hook of manifest.webhooks ?? []) {
    const verifier = manifest.functions.find((fn) => fn.universalId === hook.verifierFunctionId);
    if (
      manifest.execution !== 'hosted' ||
      !manifest.source ||
      !manifest.source.syncFunctionIds.includes(hook.syncFunctionId) ||
      !verifier ||
      !['route', 'serverRoute'].includes(verifier.trigger.kind) ||
      !('route' in verifier.trigger) ||
      verifier.trigger.route !== hook.route ||
      verifier.timeoutSeconds > 5 ||
      !manifest.settings[hook.secretSetting]?.secret ||
      new Set(hook.headers).size !== hook.headers.length ||
      hookRoutes.has(hook.route) ||
      (verifier.trigger.kind === 'serverRoute') !== (hook.accountHeader !== undefined) ||
      (hook.accountHeader !== undefined &&
        (manifest.source.identity !== 'account' || !hook.headers.includes(hook.accountHeader)))
    )
      throw new Error('unsupported_manifest: invalid pinned webhook contract');
    hookRoutes.add(hook.route);
  }
  const routes = manifest.functions
    .filter((f) => 'route' in f.trigger)
    .map((f) => ('route' in f.trigger ? f.trigger.route : ''));
  if (new Set(routes).size !== routes.length)
    throw new Error('unsupported_manifest: duplicate route');
  if (new Set(manifest.functions.map((f) => f.name)).size !== manifest.functions.length)
    throw new Error('unsupported_manifest: duplicate function name');
  for (const definition of Object.values(manifest.settings))
    if (definition.secret && definition.type !== 'string')
      throw new Error('unsupported_manifest: secrets must be strings');
  for (const fn of manifest.functions) checkFunction(fn);
  if (manifest.source) {
    const source = manifest.source;
    if (
      manifest.execution !== 'hosted' ||
      !manifest.scopes.includes('write') ||
      !manifest.scopes.includes('read')
    )
      throw new Error('unsupported_manifest: managed sources require hosted write authority');
    if (
      manifest.functions.find((f) => f.universalId === source.verifyFunctionId)?.trigger.kind !==
      'install'
    )
      throw new Error(
        'unsupported_manifest: source verification requires a registered install function',
      );
    if (
      new Set(source.syncFunctionIds).size !== source.syncFunctionIds.length ||
      new Set(source.eventTypeIds).size !== source.eventTypeIds.length
    )
      throw new Error('unsupported_manifest: duplicate source binding');
    const scans = source.scanFunctionIds ?? [];
    if (
      new Set(scans).size !== scans.length ||
      scans.some((id) => source.syncFunctionIds.includes(id))
    )
      throw new Error('unsupported_manifest: duplicate source scan binding');
    for (const id of scans) {
      const kind = manifest.functions.find((f) => f.universalId === id)?.trigger.kind;
      if (kind !== 'job' && kind !== 'schedule')
        throw new Error('unsupported_manifest: source scans require job or schedule functions');
    }
    for (const id of source.syncFunctionIds) {
      const fn = manifest.functions.find((f) => f.universalId === id);
      const input = fn?.inputSchema;
      if (
        fn?.trigger.kind !== 'job' ||
        input?.type !== 'object' ||
        input.additionalProperties !== false ||
        input.required?.length !== 1 ||
        input.required[0] !== 'sourceItemId' ||
        Object.keys(input.properties ?? {}).length !== 1 ||
        input.properties?.sourceItemId?.type !== 'string' ||
        input.properties.sourceItemId.maxLength !== 36
      )
        throw new Error('unsupported_manifest: source jobs accept only a local sourceItemId');
    }
  }
  for (const view of manifest.views) {
    if (new Set(view.fieldIds).size !== view.fieldIds.length)
      throw new Error('unsupported_manifest: duplicate view field');
  }
  return manifest;
}
export function defineFunction(value: unknown) {
  bounded(value);
  const fn = functionSchema.parse(value);
  checkFunction(fn);
  return fn;
}
export const defineView = (value: unknown) => viewSchema.parse(value);

export type ExtensionInstallInput = {
  /** Set for an upgrade preview and commit. */
  installationId?: string;
  /** Explicitly review a new credential/account connection on the current release. */
  reconnect?: boolean;
  /** Retire the old source binding and callback addresses; retained evidence keeps its namespace. */
  replaceSourceAccount?: boolean;
  /** Request a separate approval plan for increased access; never grants access on preview. */
  grantChange?: boolean;
  secretRefs?: Record<string, string>;
  registrationId: string;
  version: string;
  settings: Record<string, string | boolean | number>;
};
export type ExtensionPreview = {
  planDigest: string;
  schemaVersion: number;
  generation: number;
  releaseDigest: string;
  operations: unknown[];
  views: { universalId: string; name: string; action: 'create' | 'retain' }[];
  grants: { actor: 'integration' | 'agent'; scopes: ('read' | 'write')[] };
  previousGrants?: { actor: 'integration' | 'agent'; scopes: ('read' | 'write')[] };
  warnings: string[];
};
export type ExtensionCredential = {
  id: string;
  kind: 'key' | 'oauth';
  prefix: string | null;
  clientId: string | null;
  generation: number;
  scopes: ('read' | 'write')[];
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
};

export type ExtensionInstallation = {
  id: string;
  registrationId: string;
  version: string;
  releaseDigest: string;
  state:
    | 'installing'
    | 'active'
    | 'setup_failed'
    | 'disabled'
    | 'upgrading'
    | 'uninstalling'
    | 'uninstalled';
  generation: number;
  settingsRevision: number;
  lastError?: string | null;
  connectionHealth?: 'ok' | 'needs_reconnect' | 'degraded';
  secrets?: Record<string, boolean>;
  settings: Record<string, string | boolean | number>;
  grantedActor: 'integration' | 'agent';
  grantedScopes: ('read' | 'write')[];
  createdBy: { type: string; id: string };
};

export * from './protocol.js';
export * from './webhook.js';
