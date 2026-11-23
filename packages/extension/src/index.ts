import { nextOccurrence } from './cron.js';
import { SYSTEM_LIFECYCLE_FUNCTION_ID } from './protocol.js';
import { parseServerRange, satisfiesServerRange } from './semver.js';
import { verifierHeaderAllowed } from './webhook.js';

export { nextOccurrence } from './cron.js';
export {
  compareVersions,
  newestReleases,
  parseServerRange,
  satisfiesServerRange,
} from './semver.js';

import { type Actor, FIELD_TYPES, isInverseRelation } from '@retainer/shared';
import { z } from 'zod';

/** The icons a sidebar link may name; the web app draws each. */
export const SIDEBAR_ICONS = [
  'app',
  'calendar',
  'clock',
  'mail',
  'chart',
  'file',
  'users',
] as const;
export type SidebarIcon = (typeof SIDEBAR_ICONS)[number];
/** The query parameter a sidebar link carries, naming the installation, for the app's sign-in. */
export const SIDEBAR_INSTALLATION_PARAM = 'retainer_installation';
/** Capabilities a function may declare in `uses`; open for later ones (model calls spec 11). */
export const EXTENSION_USES = ['model'] as const;
export type ExtensionUse = (typeof EXTENSION_USES)[number];
/** What approving `model` means when the release isn't at hand to say when (model calls spec 3.1). */
export const MODEL_USE_NOTICE =
  'This extension can send the workspace data it works on to Anthropic, to process it with a model.';
/**
 * What approving `model` means for this release, in plain words: when it
 * sends workspace data to Anthropic, read from which functions declare model
 * use (model calls spec 3.1). Undefined when none does.
 */
export function modelUseNotice(manifest: Pick<ExtensionManifest, 'functions'>) {
  const kinds = manifest.functions
    .filter((fn) => fn.uses?.includes('model'))
    .map((fn) => fn.trigger.kind);
  if (!kinds.length) return undefined;
  const setup = kinds.includes('configure');
  if (kinds.every((kind) => kind === 'configure'))
    return 'To suggest how to set it up, this extension sends the workspace data it needs, such as your lists and fields, to Anthropic. It does this only while preparing suggestions: after you approve access, and when you ask for new ones.';
  return `When it runs, this extension sends the workspace data it works on to Anthropic, to process it with a model.${
    setup ? ' It also does this to suggest how to set it up.' : ''
  }`;
}
/**
 * The installation setting that chooses what happens when the source deletes
 * an item it imported; absent, the release's `onSourceDelete` applies.
 */
export const SOURCE_DELETE_SETTING = 'onSourceDelete';
const sourceDeletePolicies = z.enum(['keep', 'retract']);
/** What happens to imported content when the source deletes it, for these installation settings. */
export function sourceDeletePolicy(
  manifest: Pick<ExtensionManifest, 'onSourceDelete' | 'settings'>,
  settings: Record<string, unknown>,
): ExtensionManifest['onSourceDelete'] {
  const chosen = sourceDeletePolicies.safeParse(settings[SOURCE_DELETE_SETTING]);
  return chosen.success && manifest.settings[SOURCE_DELETE_SETTING]?.options?.includes(chosen.data)
    ? chosen.data
    : manifest.onSourceDelete;
}
/**
 * Plain words for the options of the policies the platform itself applies,
 * wherever they are chosen or shown.
 */
export const POLICY_OPTION_LABELS: Record<string, Record<string, string>> = {
  createPeople: {
    never: 'Never',
    contacted_first: 'Only people you contacted first',
    everyone: 'Everyone',
  },
  [SOURCE_DELETE_SETTING]: {
    retract: 'Remove what was imported',
    keep: 'Keep what was imported',
  },
};

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
// A deliberately small JSON Schema subset. No refs, arbitrary keywords or executable defaults.
export type InputSchema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
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
    description: z.string().max(2000).optional(),
    properties: z.record(name, inputSchema).optional(),
    required: z.array(name).max(100).optional(),
    additionalProperties: z.literal(false).optional(),
    items: inputSchema.optional(),
    maxLength: z.number().int().min(1).max(65536).optional(),
    maxItems: z.number().int().min(1).max(1000).optional(),
  }),
);
// `then` would make the routine SDK's tools object look like a promise.
const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,99}$/)
  .refine((name) => name !== 'then', 'a tool cannot be named "then"');
const toolTrigger = z.strictObject({
  kind: z.literal('tool'),
  title: label,
  effect: z.enum(['read', 'write', 'send']),
  connection: z.enum(['workspace', 'member']),
  outputSchema: inputSchema,
});
export const bindingKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/);
const trigger = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('configure') }),
  z.strictObject({ kind: z.literal('install') }),
  z.strictObject({ kind: z.literal('uninstall') }),
  z.strictObject({ kind: z.literal('connect') }),
  z.strictObject({ kind: z.literal('disconnect') }),
  z.strictObject({ kind: z.literal('job') }),
  toolTrigger,
  z.strictObject({ kind: z.literal('route'), route: name }),
  z.strictObject({ kind: z.literal('serverRoute'), route: name }),
  z.strictObject({
    kind: z.literal('schedule'),
    cron: z.string().min(9).max(100),
    timezone: z.literal('UTC'),
  }),
  z.strictObject({
    kind: z.literal('change'),
    binding: bindingKeySchema,
    fields: z.array(bindingKeySchema).max(200).optional(),
    /**
     * Whether a change to a related record (a link to or from it, or a merge
     * into it) also fires the trigger. Absent means true, the first contract.
     */
    related: z.boolean().optional(),
    /**
     * Only these direct operations fire it. With `fields`, `update` still
     * needs a watched field and `create` can fire. Absent means every
     * operation, the first contract.
     */
    operations: z
      .array(z.enum(['create', 'update']))
      .min(1)
      .max(2)
      .optional(),
  }),
]);
const functionDefinition = z.strictObject({
  universalId: uuid,
  name: z.string(),
  description: z.string().min(1).max(2000),
  handlerDigest: digest,
  trigger,
  inputSchema,
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
  /**
   * The secret settings this function reads or writes. Its run receives only
   * these. Absent (the first contract) means every secret setting, so
   * already-built catalogs and their digests stay valid.
   */
  secrets: z.array(name).max(100).optional(),
  /**
   * The runtime scopes this function needs, a subset of the release's scopes.
   * Its run token carries the intersection with the installed grant. Absent
   * means the release's scopes.
   */
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .max(2)
    .optional(),
  /**
   * The function may write the release's mapped outputs through the fill-only
   * mapped write. Reviewed with the release, like `secrets` and `scopes`.
   */
  mappedWrite: name.optional(),
  /**
   * Platform capabilities the function uses (model calls spec 3.1). Reviewed
   * with the release and approved with its access; a run gets one only when
   * its function declares it and the installation's grant includes it.
   */
  uses: z.array(z.enum(EXTENSION_USES)).min(1).optional(),
});
export const functionSchema = functionDefinition.refine(
  (fn) => (fn.trigger.kind === 'tool' ? toolName : name).safeParse(fn.name).success,
  { path: ['name'], message: 'invalid name for function trigger' },
);
const toolDefinition = functionDefinition
  .omit({ trigger: true })
  .extend({ ...toolTrigger.omit({ kind: true }).shape, name: toolName });
/** A field destination declared by an extension binding. */
const bindingFieldSchema = z.strictObject({
  key: bindingKeySchema,
  label,
  description: z.string().max(2000).optional(),
  types: z.array(z.enum(FIELD_TYPES)).min(1).max(FIELD_TYPES.length),
  required: z.boolean(),
  lookup: z.literal(true).optional(),
  owned: z.literal(true).optional(),
  installationOwned: z.literal(true).optional(),
  target: bindingKeySchema.optional(),
  values: z.array(name).min(1).max(200).optional(),
  create: field.optional(),
});

const bindingSchema = z.strictObject({
  key: bindingKeySchema,
  label,
  description: z.string().min(1).max(2000),
  class: z.enum(['entity', 'event']),
  access: z.enum(['read', 'write']),
  required: z.boolean(),
  owned: z.literal(true).optional(),
  match: bindingKeySchema.optional(),
  /** This binding creates records, so all required schema fields must be supplied. */
  creates: z.literal(true).optional(),
  fields: z.array(bindingFieldSchema).max(200),
  create: object.optional(),
});
export type ExtensionBinding = z.infer<typeof bindingSchema>;

/**
 * Whether a field can hold a binding field's values: not an event type's core
 * field, not the read-only side of a relation, and of a type the binding field
 * takes. The server adds that the field is active; API clients, which see
 * `readOnly`, add that it is writable. One rule for the server, the bundles
 * that suggest bindings and the web form.
 */
export function bindableField(
  field: { type: string; coreRole?: unknown; settings: { isInverse?: boolean } },
  rule: { types: readonly string[] },
): boolean {
  return !field.coreRole && !isInverseRelation(field) && rule.types.includes(field.type);
}
/** The longest reason a `configure` run may save for one suggestion (configure spec 2.2). */
export const SUGGESTION_REASON_MAX = 500;

const bindingValueSchema = z.union([name, z.strictObject({ value: name, label })]);
const bindingFieldChoice = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({
    action: z.literal('existing'),
    field: name,
    values: z.record(name, bindingValueSchema).optional(),
  }),
  z.strictObject({
    action: z.literal('create'),
    name: name.optional(),
    values: z.record(name, bindingValueSchema).optional(),
  }),
]);
const bindingFields = z.record(bindingKeySchema, bindingFieldChoice).optional();
export const bindingChoicesSchema = z.record(
  bindingKeySchema,
  z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('skip') }),
    z.strictObject({
      action: z.literal('existing'),
      objects: z.array(name).min(1).max(20),
      fields: bindingFields,
    }),
    z.strictObject({
      action: z.literal('create'),
      nameSingular: name.optional(),
      namePlural: name.optional(),
      labelSingular: label.optional(),
      labelPlural: label.optional(),
      fields: bindingFields,
    }),
  ]),
);
export type ExtensionBindingChoices = z.infer<typeof bindingChoicesSchema>;

/** Later proposals take precedence, retaining suggestions for the same target. */
export function mergeBindingChoices(
  ...proposals: (ExtensionBindingChoices | null | undefined)[]
): ExtensionBindingChoices {
  const result: ExtensionBindingChoices = {};
  for (const proposal of proposals) {
    for (const [key, choice] of Object.entries(proposal ?? {})) {
      const prior = result[key];
      if (
        !prior ||
        prior.action === 'skip' ||
        choice.action === 'skip' ||
        prior.action !== choice.action ||
        (prior.action === 'existing' &&
          choice.action === 'existing' &&
          (prior.objects.length !== choice.objects.length ||
            !prior.objects.every((object, index) => object === choice.objects[index])))
      ) {
        result[key] = choice;
        continue;
      }
      const fields = { ...prior.fields };
      for (const [fieldKey, field] of Object.entries(choice.fields ?? {})) {
        const previous = fields[fieldKey];
        fields[fieldKey] =
          (previous?.action === 'existing' &&
            field.action === 'existing' &&
            previous.field === field.field) ||
          (previous?.action === 'create' &&
            field.action === 'create' &&
            previous.name === field.name)
            ? { ...field, values: { ...previous.values, ...field.values } }
            : field;
      }
      result[key] = { ...prior, ...choice, fields };
    }
  }
  return result;
}

export const bindingWriteStampSchema = z.strictObject({
  bindings_revision: z.number().int().positive(),
  objectId: uuid,
  fieldIds: z.record(z.string().min(1).max(100), uuid),
});
export type BindingWriteStamp = z.infer<typeof bindingWriteStampSchema>;

export type { ExtensionBindingPlan } from './protocol.js';

const viewDefinition = z.strictObject({ universalId: uuid, name: label, kind: z.literal('table') });
export const viewSchema = viewDefinition.extend({
  binding: bindingKeySchema,
  fields: z.array(bindingKeySchema).max(200),
});

const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  universalId: uuid,
  name,
  version,
  description: z.string().min(1).max(2000),
  packageDigest: digest,
  /**
   * The reviewed servers this release supports, as a bounded semver range
   * (`semver.ts`), e.g. `>=0.1.0 <0.2.0`. A server patch inside the range needs
   * no new release.
   */
  serverRange: z.string().max(200).optional(),
  /**
   * The first contract's exact list. Still accepted, as an exact set, so
   * already-built catalogs and their digests stay valid. Give one or the other.
   */
  serverVersions: z.array(version).min(1).max(100).optional(),
  runtimeVersion: z.literal('node24'),
  execution: z.enum(['hosted', 'standalone']),
  /** Reviewed first-party OAuth client identity, pinned into the release digest. */
  oauthClientId: z.string().min(1).max(2048).regex(/^\S+$/).optional(),
  /**
   * A link in Retainer's sidebar for members of workspaces where the
   * installation is active (spec 8). The path is on the app's origin, the
   * origin of its client's registered redirect; opening it signs the person
   * in to the app through Retainer.
   */
  sidebarLink: z
    .strictObject({
      label: z.string().min(1).max(40),
      icon: z.enum(SIDEBAR_ICONS),
      // An absolute path with no query or fragment: Retainer adds the query.
      path: z
        .string()
        .max(500)
        .regex(/^\/(?![/\\])[A-Za-z0-9\-._~/%!$&'()*+,;=:@]*$/),
    })
    .optional(),
  protocolVersion: z.literal(1),
  requestedActor: z.enum(['integration', 'agent']),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .max(2),
  connection: z.enum(['workspace', 'member']),
  createPeople: z.enum(['never', 'contacted_first', 'everyone']),
  onSourceDelete: sourceDeletePolicies,
  /** Narrow server-computed derivation; only these functions may replace their own derived claims. */
  lastContact: z
    .strictObject({
      functionIds: z.array(uuid).min(1).max(20),
      events: bindingKeySchema,
      destinations: z.array(bindingKeySchema).min(1).max(20),
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
      event: bindingKeySchema,
      people: bindingKeySchema.optional(),
      revisionOrder: z.enum(['integer', 'timestamp', 'opaque']),
      /** Server-managed derived task identities; only the pinned ingestion functions may reconcile them. */
      tasks: bindingKeySchema.optional(),
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
      /** Absent means installation; keep old serialized manifests and release digests unchanged. */
      level: z.enum(['installation', 'connection']).optional(),
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
  bindings: z.array(bindingSchema).max(100).optional(),
  views: z.array(viewSchema).max(100),
  functions: z.array(functionSchema).max(100),
  /**
   * A member connection may connect by OAuth (Tamloot connect spec 4.2). The
   * server stages the verifier and the code; the bundle stores the tokens.
   * No defaults, so manifests without it keep their digests.
   */
  oauth: z
    .strictObject({
      verifierSetting: name,
      codeSetting: name,
      tokenSetting: name,
      keySetting: name.optional(),
      /** Where a member revokes the app; shown as a link. */
      revokeUrl: z.url(),
    })
    .optional(),
  /** Shown to a member whose active connection has imported nothing yet. */
  gettingStarted: z
    .strictObject({
      text: z.string().min(1).max(300),
      linkLabel: z.string().min(1).max(60),
      url: z.url(),
    })
    .optional(),
});
export type ExtensionManifest = z.infer<typeof manifestSchema>;

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
  if (fn.trigger.kind === 'tool') checkInput(fn.trigger.outputSchema);
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
    const watched = fn.trigger.fields ?? [];
    if (new Set(watched).size !== watched.length)
      throw new Error('unsupported_manifest: duplicate watched field');
    const operations = fn.trigger.operations ?? [];
    if (new Set(operations).size !== operations.length)
      throw new Error('unsupported_manifest: duplicate trigger operation');
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
function checkBindings(manifest: ExtensionManifest): void {
  const bindings = manifest.bindings ?? [];
  const byKey = new Map(bindings.map((binding) => [binding.key, binding]));
  const keys = new Set(byKey.keys());
  for (const { trigger } of manifest.functions) {
    if (trigger.kind !== 'change' || !trigger.binding) continue;
    const bound = byKey.get(trigger.binding);
    if (!bound || trigger.fields?.some((key) => !bound.fields.some((field) => field.key === key)))
      throw new Error('unsupported_manifest: change trigger names an unknown binding or field');
  }
  if (keys.size !== bindings.length) throw new Error('unsupported_manifest: duplicate binding key');
  for (const view of manifest.views) {
    const binding = byKey.get(view.binding);
    if (
      !binding ||
      (binding.class === 'event' && binding.access === 'read') ||
      new Set(view.fields).size !== view.fields.length ||
      view.fields.some((key) => !binding.fields.some((field) => field.key === key))
    )
      throw new Error('unsupported_manifest: view names an unknown binding or field');
  }
  for (const binding of bindings) {
    const fields = new Map(binding.fields.map((field) => [field.key, field]));
    if (fields.size !== binding.fields.length)
      throw new Error(`unsupported_manifest: duplicate field in binding ${binding.key}`);
    if (binding.owned && !binding.create)
      throw new Error(
        `unsupported_manifest: owned binding ${binding.key} needs a create definition`,
      );
    if (binding.creates && binding.access !== 'write')
      throw new Error(
        `unsupported_manifest: creating through ${binding.key} requires write access`,
      );
    if (binding.match) {
      const match = fields.get(binding.match);
      if (!match?.required || match.types.length !== 1 || match.types[0] !== 'emails')
        throw new Error(`unsupported_manifest: ${binding.key} needs a required emails match field`);
    }
    for (const field of binding.fields) {
      if (
        (field.target && (!keys.has(field.target) || field.types.join() !== 'relation')) ||
        (field.values &&
          (field.types.join() !== 'select' ||
            new Set(field.values).size !== field.values.length)) ||
        (field.owned && (!field.create || field.lookup)) ||
        (field.installationOwned && !field.owned) ||
        (field.create && !field.types.includes(field.create.type))
      )
        throw new Error(`unsupported_manifest: invalid field ${binding.key}.${field.key}`);
    }
  }
}

function checkBoundWrites(manifest: ExtensionManifest): void {
  for (const fn of manifest.functions) {
    if (!fn.mappedWrite) continue;
    const binding = manifest.bindings?.find((entry) => entry.key === fn.mappedWrite);
    if (
      manifest.execution !== 'hosted' ||
      binding?.access !== 'write' ||
      binding.class !== 'entity'
    )
      throw new Error('unsupported_manifest: mapped writes require a hosted entity write binding');
    if (
      !['job', 'change', 'schedule'].includes(fn.trigger.kind) ||
      !functionScopes(manifest, fn).includes('write')
    )
      throw new Error('unsupported_manifest: mapped writes require a runtime function with write');
  }
}

type FunctionDefinition = ExtensionManifest['functions'][number];

/** The secret settings a function can access. */
export function functionSecrets(
  manifest: Pick<ExtensionManifest, 'settings'>,
  fn: Pick<FunctionDefinition, 'secrets'> & { trigger?: FunctionDefinition['trigger'] },
): string[] {
  // A disconnect hook gets only what it declares: generated connection secrets (connect spec 4.2).
  if (fn.trigger?.kind === 'disconnect') return fn.secrets ?? [];
  return (
    fn.secrets ??
    Object.entries(manifest.settings)
      .filter(([, definition]) => definition.secret)
      .map(([key]) => key)
  );
}

/** A release's disconnect hook and the generated secrets it may read after a disconnect. */
export function disconnectHook(manifest: Pick<ExtensionManifest, 'settings' | 'functions'>): {
  functionId: string | null;
  secrets: string[];
} {
  const fn = manifest.functions.find((f) => f.trigger.kind === 'disconnect');
  return { functionId: fn?.universalId ?? null, secrets: fn ? functionSecrets(manifest, fn) : [] };
}
/** The function kinds a standalone release may declare (spec 8). */
const STANDALONE_TRIGGERS: string[] = ['tool', 'job'];
/**
 * Whether a release runs code in the hosted runtime: every hosted release,
 * and a standalone one with functions. Such a release follows the hosted
 * rules for `runtimeEnabled`, executable admission and readiness (spec 8);
 * `execution` decides only how the app's own service gets its credential and
 * how the installation activates.
 */
export function runsHostedCode(manifest: Pick<ExtensionManifest, 'execution' | 'functions'>) {
  return manifest.execution === 'hosted' || manifest.functions.length > 0;
}
/** The scopes a function needs; its run token gets their intersection with the grant (spec 8). */
export function functionScopes(
  manifest: Pick<ExtensionManifest, 'scopes'>,
  fn: Pick<FunctionDefinition, 'scopes'>,
): ('read' | 'write')[] {
  return fn.scopes ?? manifest.scopes;
}
/** The capabilities a function's run may receive, before the installation's grant (spec 3.1). */
export function functionUses(fn: Pick<FunctionDefinition, 'uses'>): ExtensionUse[] {
  return fn.uses ?? [];
}
/** A release's uses: the union of its functions'. Approved with its access. */
export function releaseUses(manifest: Pick<ExtensionManifest, 'functions'>): ExtensionUse[] {
  return EXTENSION_USES.filter((use) => manifest.functions.some((fn) => fn.uses?.includes(use)));
}
/** Whether a release supports this server: inside its range, or in its exact list. */
export function supportsServer(
  manifest: Pick<ExtensionManifest, 'serverRange' | 'serverVersions'>,
  serverVersion: string,
): boolean {
  if (manifest.serverRange !== undefined)
    return satisfiesServerRange(serverVersion, manifest.serverRange);
  return manifest.serverVersions?.includes(serverVersion) ?? false;
}
/** Member credentials and hooks have their own scope; workspace releases retain the first contract. */
function checkConnections(manifest: ExtensionManifest): void {
  const hooks = (kind: 'connect' | 'disconnect') =>
    manifest.functions.filter((fn) => fn.trigger.kind === kind);
  const https = (url: string) => {
    if (new URL(url).protocol !== 'https:')
      throw new Error('unsupported_manifest: manifest links must use https');
  };
  if (manifest.oauth) https(manifest.oauth.revokeUrl);
  if (manifest.gettingStarted) https(manifest.gettingStarted.url);
  if (manifest.connection === 'workspace') {
    if (
      Object.values(manifest.settings).some((setting) => setting.level === 'connection') ||
      hooks('connect').length ||
      hooks('disconnect').length ||
      manifest.oauth ||
      manifest.gettingStarted
    )
      throw new Error(
        'unsupported_manifest: workspace releases cannot declare member settings or hooks',
      );
    return;
  }
  if (manifest.execution !== 'hosted')
    throw new Error('unsupported_manifest: member connections require hosted execution');
  if (hooks('connect').length !== 1 || hooks('disconnect').length > 1)
    throw new Error(
      'unsupported_manifest: member releases require one connect and at most one disconnect hook',
    );
  if (manifest.webhooks?.length)
    throw new Error('unsupported_manifest: member webhooks are not supported');
  if (manifest.functions.some((fn) => ['change', 'route', 'serverRoute'].includes(fn.trigger.kind)))
    throw new Error(
      'unsupported_manifest: member releases cannot declare change or route triggers',
    );
  if (manifest.source && manifest.source.identity !== 'account')
    throw new Error('unsupported_manifest: member sources require account identity');
  for (const setting of Object.values(manifest.settings)) {
    if (setting.secret && setting.level !== 'connection')
      throw new Error('unsupported_manifest: member secrets require connection level');
    if (setting.consent && setting.level === 'connection')
      throw new Error('unsupported_manifest: sharing consent requires installation level');
  }
  const generatedConnectionSecret = (key: string) => {
    const setting = manifest.settings[key];
    return (
      !!setting && setting.level === 'connection' && setting.secret && setting.generated === true
    );
  };
  if (
    hooks('disconnect').some((fn) =>
      (fn.secrets ?? []).some((key) => !generatedConnectionSecret(key)),
    )
  )
    throw new Error(
      'unsupported_manifest: disconnect hooks may request only generated connection secrets',
    );
  const oauth = manifest.oauth;
  if (!oauth) return;
  const handshake = [oauth.verifierSetting, oauth.codeSetting, oauth.tokenSetting];
  if (new Set(handshake).size !== 3 || !handshake.every(generatedConnectionSecret))
    throw new Error(
      'unsupported_manifest: OAuth verifier, code and token settings must be three generated connection secrets',
    );
  if (oauth.keySetting !== undefined) {
    const key = manifest.settings[oauth.keySetting];
    if (
      key?.level !== 'connection' ||
      !key.secret ||
      key.generated ||
      handshake.includes(oauth.keySetting)
    )
      throw new Error(
        'unsupported_manifest: the OAuth key setting must be a connection secret that is not generated',
      );
  }
  if (
    Object.values(manifest.settings).some(
      (setting) => setting.level === 'connection' && setting.secret && setting.required,
    )
  )
    throw new Error(
      'unsupported_manifest: with OAuth, no connection secret may be required; the method decides',
    );
  const connect = hooks('connect')[0];
  if (!connect || !handshake.every((key) => functionSecrets(manifest, connect).includes(key)))
    throw new Error('unsupported_manifest: the connect hook must declare the OAuth secrets');
}
export function defineExtension(value: unknown): ExtensionManifest {
  bounded(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576)
    throw new Error('unsupported_manifest: maximum size is 1 MiB');
  const manifest = manifestSchema.parse(value);
  checkBindings(manifest);
  if ((manifest.serverRange === undefined) === (manifest.serverVersions === undefined))
    throw new Error('unsupported_manifest: give exactly one of serverRange or serverVersions');
  if (manifest.serverRange !== undefined) parseServerRange(manifest.serverRange);
  const deletion = manifest.settings[SOURCE_DELETE_SETTING];
  if (
    deletion &&
    (!manifest.source ||
      deletion.type !== 'string' ||
      deletion.secret ||
      (deletion.level ?? 'installation') !== 'installation' ||
      !deletion.options?.length ||
      deletion.options.some((option) => !sourceDeletePolicies.safeParse(option).success) ||
      (deletion.default !== undefined && !deletion.options.includes(String(deletion.default))))
  )
    throw new Error(
      'unsupported_manifest: onSourceDelete must be an installation choice of keep or retract on a source release',
    );
  const configure = manifest.functions.filter((fn) => fn.trigger.kind === 'configure');
  if (
    configure.length > 1 ||
    configure.some(
      (fn) =>
        fn.scopes?.length !== 1 ||
        fn.scopes[0] !== 'read' ||
        fn.mappedWrite ||
        functionSecrets(manifest, fn).some(
          (name) => manifest.settings[name]?.level === 'connection',
        ),
    )
  )
    throw new Error('unsupported_manifest: configure requires read-only installation access');
  if (
    configure.length &&
    (!manifest.scopes.includes('read') ||
      (!manifest.bindings?.length &&
        !Object.values(manifest.settings).some((s) => !s.secret && s.level !== 'connection')))
  )
    throw new Error('unsupported_manifest: configure needs bindings or non-secret settings');
  const ids = [
    manifest.universalId,
    ...manifest.functions.map((f) => f.universalId),
    ...manifest.views.map((v) => v.universalId),
    ...(manifest.bindings ?? []).flatMap((binding) => [
      ...(binding.create ? [binding.create.universalId] : []),
      ...binding.fields.flatMap((field) => (field.create ? [field.create.universalId] : [])),
      ...(binding.create?.fields.map((field) => field.universalId) ?? []),
    ]),
  ];
  if (manifest.functions.some((fn) => fn.universalId === SYSTEM_LIFECYCLE_FUNCTION_ID))
    throw new Error('unsupported_manifest: reserved lifecycle function ID');
  if (new Set(ids).size !== ids.length)
    throw new Error('unsupported_manifest: duplicate universal ID');
  if (new Set(manifest.scopes).size !== manifest.scopes.length)
    throw new Error('unsupported_manifest: duplicate scope');
  if (manifest.oauthClientId && manifest.execution !== 'standalone')
    throw new Error('unsupported_manifest: OAuth clients require standalone execution');
  // Signing in through Retainer needs accounts mode, which an OAuth client marks.
  if (manifest.sidebarLink && !manifest.oauthClientId)
    throw new Error('unsupported_manifest: a sidebar link requires a standalone OAuth client');
  // A standalone app activates when it is approved, with no setup job, so it
  // may declare only functions that need no activation: tools and their jobs.
  if (
    manifest.execution === 'standalone' &&
    manifest.functions.some((fn) => !STANDALONE_TRIGGERS.includes(fn.trigger.kind))
  )
    throw new Error(
      'unsupported_manifest: standalone apps may declare only tool and job functions',
    );
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
  checkConnections(manifest);
  if (manifest.lastContact) {
    const policy = manifest.lastContact;
    const bindings = manifest.bindings ?? [];
    if (
      !bindings.some(
        (b) => b.key === policy.events && b.class === 'event' && b.access === 'read',
      ) ||
      new Set(policy.destinations).size !== policy.destinations.length ||
      !policy.destinations.every((key) =>
        bindings.some(
          (b) =>
            b.key === key &&
            b.class === 'entity' &&
            b.access === 'write' &&
            b.fields.some(
              (field) =>
                field.key === 'lastContact' &&
                field.owned &&
                field.types.join() === 'date_time' &&
                field.create?.isNullable !== false &&
                field.create?.isUnique !== true,
            ),
        ),
      )
    )
      throw new Error(
        'unsupported_manifest: Last contact requires an event read binding and owned date-time fields.',
      );

    if (
      manifest.execution !== 'hosted' ||
      !manifest.scopes.includes('read') ||
      !manifest.scopes.includes('write') ||
      new Set(policy.functionIds).size !== policy.functionIds.length ||
      policy.functionIds.some(
        (id) =>
          !manifest.functions.some(
            (fn) =>
              fn.universalId === id && ['job', 'change', 'schedule'].includes(fn.trigger.kind),
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
  for (const fn of manifest.functions) {
    checkFunction(fn);
    if (fn.trigger.kind === 'tool' && fn.trigger.connection !== manifest.connection)
      throw new Error('unsupported_manifest: tool connection must match the release');
    if (
      fn.secrets &&
      (new Set(fn.secrets).size !== fn.secrets.length ||
        fn.secrets.some((key) => !manifest.settings[key]?.secret))
    )
      throw new Error('unsupported_manifest: function secrets must name distinct secret settings');
    if (
      fn.scopes &&
      (new Set(fn.scopes).size !== fn.scopes.length ||
        fn.scopes.some((scope) => !manifest.scopes.includes(scope)))
    )
      throw new Error('unsupported_manifest: function scopes must be distinct release scopes');
    if (fn.uses && new Set(fn.uses).size !== fn.uses.length)
      throw new Error('unsupported_manifest: duplicate function use');
    // Webhook verifiers have no network.
    if (fn.uses?.length && ['route', 'serverRoute'].includes(fn.trigger.kind))
      throw new Error('unsupported_manifest: webhook verifiers cannot use platform capabilities');
  }
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
      (manifest.connection === 'member' ? 'connect' : 'install')
    )
      throw new Error(
        `unsupported_manifest: source verification requires a registered ${manifest.connection === 'member' ? 'connect' : 'install'} function`,
      );
    const binding = (key: string | undefined) => manifest.bindings?.find((b) => b.key === key);
    if (
      binding(source.event)?.class !== 'event' ||
      binding(source.event)?.access !== 'write' ||
      !binding(source.event)?.required ||
      !binding(source.event)?.creates
    )
      throw new Error(
        'unsupported_manifest: sources need a required write event binding that creates records',
      );
    if (
      source.people &&
      (binding(source.people)?.class !== 'entity' || !binding(source.people)?.match)
    )
      throw new Error('unsupported_manifest: source people need an email match field');
    if (
      source.tasks &&
      (binding(source.tasks)?.class !== 'entity' ||
        !binding(source.tasks)?.creates ||
        binding(source.tasks)?.access !== 'write')
    )
      throw new Error('unsupported_manifest: source tasks need an entity that creates records');
    if (new Set(source.syncFunctionIds).size !== source.syncFunctionIds.length)
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
  checkBoundWrites(manifest);
  return manifest;
}
export function defineFunction(value: unknown) {
  bounded(value);
  const fn = functionSchema.parse(value);
  checkFunction(fn);
  return fn;
}
export function defineTool(value: unknown) {
  bounded(value);
  const { title, effect, connection, outputSchema, ...fn } = toolDefinition.parse(value);
  const tool = {
    ...fn,
    trigger: { kind: 'tool' as const, title, effect, connection, outputSchema },
  };
  checkFunction(tool);
  return tool;
}
export const defineView = (value: unknown) => viewSchema.parse(value);

export type ExtensionInstallInput = {
  /** Access-only preview/approval for a target release. */
  accessOnly?: boolean;
  /** Explicit final approval of a configuring installation. */
  turnOn?: boolean;
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
  bindings?: ExtensionBindingChoices;
};
export type ExtensionPreview = {
  planDigest: string;
  schemaVersion: number;
  generation: number;
  releaseDigest: string;
  operations: unknown[];
  /**
   * `update` applies the publisher's change to an unedited view;
   * `keep_workspace` keeps a view the workspace edited and `deleted_workspace`
   * leaves one it deleted absent (a warning says so for both).
   */
  views: {
    universalId: string;
    name: string;
    action: 'create' | 'retain' | 'update' | 'keep_workspace' | 'deleted_workspace';
  }[];
  /** `uses` lists the release's platform capabilities; `model` sends workspace data to Anthropic. */
  grants: { actor: 'integration' | 'agent'; scopes: ('read' | 'write')[]; uses: ExtensionUse[] };
  previousGrants?: {
    actor: 'integration' | 'agent';
    scopes: ('read' | 'write')[];
    uses: ExtensionUse[];
  };
  bindings?: ExtensionBindingChoices;
  /** Plain facts about the access being approved, such as when it uses a model. */
  notices: string[];
  /** Cautions: what approving changes or leaves undone that the admin may not expect. */
  warnings: string[];
};
export type ExtensionCredential = {
  id: string;
  kind: 'key' | 'oauth';
  prefix: string | null;
  clientId: string | null;
  /** The installation grant generation this credential was issued for. */
  generation: number;
  scopes: ('read' | 'write')[];
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
};

export type ExtensionInstallation = {
  /** Latest configure run for the installed release, when there is one. */
  suggestionsStatus?: 'queued' | 'running' | 'ready' | 'failed';
  id: string;
  registrationId: string;
  version: string;
  releaseDigest: string;
  state:
    | 'configuring'
    | 'installing'
    | 'active'
    | 'setup_failed'
    | 'disabled'
    | 'upgrading'
    | 'uninstalling'
    | 'uninstalled';
  /** Fences runs: changes on every release, settings or state change. */
  generation: number;
  /** What standalone keys and app grants bind to: changes only on disable, uninstall, grant change or reconnect. */
  grantGeneration: number;
  settingsRevision: number;
  lastError?: string | null;
  connectionHealth?: 'ok' | 'needs_reconnect' | 'degraded';
  /** Availability in this server's catalog, computed on read; independent of the provider connection. */
  runtimeAvailability?:
    | { state: 'available' }
    | { state: 'unavailable'; code: 'incompatible_runtime' | 'release_unavailable' };
  secrets?: Record<string, boolean>;
  settings: Record<string, string | boolean | number>;
  grantedActor: 'integration' | 'agent';
  grantedScopes: ('read' | 'write')[];
  /** Platform capabilities an admin approved, such as `model` (model calls spec 3.1). */
  grantedUses: ExtensionUse[];
  createdBy: { type: string; id: string };
  bindingChoices?: ExtensionBindingChoices;
  /** How a member may connect, for a member release: OAuth, a pasted key, or both. */
  connectionMethods?: ExtensionConnectionMethod[];
  /**
   * The caller's most recent connection whose provider access may remain and
   * whose notice they have not dismissed. `at` is opaque: send it back unchanged.
   */
  releaseNotice?: { connectionId: string; at: string } | null;
};
export type ExtensionConnectionMethod = 'oauth' | 'key';
/** A standalone app's sidebar link, for a member of a workspace where it is active (spec 8). */
export type ExtensionAppLink = {
  installationId: string;
  name: string;
  label: string;
  icon: SidebarIcon;
  /** The app's page; it names the installation in `retainer_installation`. */
  url: string;
};

export * from './model.js';
export * from './protocol.js';
export * from './webhook.js';

/** A person's credential boundary beneath the installation's approved workspace grant. */
export type ExtensionConnection = {
  id: string;
  installationId: string;
  owner: Actor;
  state: 'connecting' | 'active' | 'setup_failed' | 'needs_reconnect' | 'disconnected';
  health: 'ok' | 'needs_reconnect' | 'degraded';
  lastError: string | null;
  generation: number;
  settings: Record<string, string | boolean | number>;
  settingsRevision: number;
  /** Names only; credentials never appear in reads. */
  secrets: string[];
  createdAt: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSuccessfulScanAt: string | null;
  failedItems: number;
  /** Fixed when the connection is created. */
  credential: ExtensionConnectionMethod;
  /** Whether the connection's source account imported at least one item. */
  hasImportedItems: boolean;
  /** When a cleanup that held provider credentials last did not finish. */
  releaseIncompleteAt: string | null;
};
export type ExtensionConnectionInput = {
  settings: Record<string, string | boolean | number>;
  secretRefs?: Record<string, string>;
  /** Required when reconnecting; a stale form cannot replace a newer credential. */
  expectedGeneration?: number;
};

export type ExtensionAuthorizeInput = {
  settings: Record<string, string | boolean | number>;
  /** Set both to reconnect an existing OAuth connection. */
  connectionId?: string;
  expectedGeneration?: number;
  /** An email the provider may prefill; carries no authority. */
  loginHint?: string;
};
export type ExtensionAuthorization = { authorizationUrl: string; state: string; expiresAt: string };
/** Exactly one of `code` and `error`. */
export type ExtensionAuthorizationCompletion = { state: string; code?: string; error?: string };
/** What a run that holds the token secret may read about the operator's OAuth client. */
export type ExtensionOAuthClient = {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  redirectUri: string;
  apiOrigin?: string;
};

export type ManagedSourceTask = {
  externalId: string;
  title: string;
  status: 'open' | 'done';
  contactEmails: string[];
};
export type SourceTaskBatchInput = {
  expectedTaskRevision: number;
  expectedRevisionId: string | null;
  tasks: ManagedSourceTask[];
  complete: boolean;
};
export type SourceTaskBatchResult = {
  applied: number;
  removed: number;
  detached: number;
  unchanged: number;
  erased: number;
  hasMore: boolean;
  checkpoint: number;
  bindingStatus: 'ok' | 'degraded';
  warnings: string[];
};
export type SourceTaskSchema = {
  status: 'ok' | 'degraded';
  fields: Record<string, { name: string; type: string }>;
  errors: { field: string; reason: string }[];
};

/** Suggestions never become approved settings or field bindings without human review. */
export type ExtensionSuggestions = {
  /** Valid target-release approval; only non-secret settings and staged secret names. */
  access?: { settings: Record<string, string | number | boolean>; secrets: string[] };
  status: 'queued' | 'running' | 'ready' | 'failed';
  code?: string;
  bindings?: ExtensionBindingChoices;
  bindingReasons?: Record<string, string>;
  settings?: Record<string, string | number | boolean>;
  issues: Record<string, string>;
};
