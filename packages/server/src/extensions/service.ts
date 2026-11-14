import {
  compareVersions,
  type ExtensionInstallation,
  type ExtensionInstallInput,
  type ExtensionManifest,
  type ExtensionMappingView,
  type ExtensionPreview,
  functionSecrets,
  MODEL_USE_NOTICE,
  mappingChoicesSchema,
  newestReleases,
  releaseUses,
} from '@retainer/extension';
import { HIDDEN_TYPE_IDS } from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import {
  inWorkspace,
  jsonValue,
  lockPrivacyShared,
  lockSchemaExclusive,
  lockSchemaShared,
  type Tx,
} from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import {
  type RuntimeCatalog,
  releaseAvailability,
  resolveRelease,
} from '../extension-runtime/availability.js';
import { disconnectConnection } from '../extension-runtime/connections.js';
import { hashInstallationKey, mintInstallationKey } from '../extension-runtime/credentials.js';
import {
  cancelRuns,
  failDisconnectCleanup,
  lockExtension as lockInstallation,
} from '../extension-runtime/locks.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import { pendingSecrets, type SecretBroker } from '../extension-runtime/secrets.js';
import { log } from '../log.js';
import { loadSchemaState } from '../schema/load.js';
import { planSchemaChange, runSchemaChange, SYSTEM_ACTOR } from '../schema-engine/engine.js';
import {
  createViewInTransaction,
  type ManagedView,
  managedViewEdited,
  replaceManagedView,
} from '../views/service.js';
import { holdReason, type UpgradeTarget, upgradeTargets } from './auto-upgrade.js';
import { ExtensionCatalog, hash } from './catalog.js';
import { MemberConnections } from './connections.js';
import {
  type ContributionRow,
  contributionOperations,
  retiredContributions,
} from './contributions.js';
import { bindingStatus, EMPTY_MAPPING, resolveMapping, type StoredMapping } from './mapping.js';
import { getSuggestions } from './suggestions.js';
import { installationMonthUsage } from './usage.js';

export const installInputSchema = z.strictObject({
  accessOnly: z.boolean().optional(),
  turnOn: z.boolean().optional(),
  installationId: z.uuid().optional(),
  reconnect: z.boolean().optional(),
  replaceSourceAccount: z.boolean().optional(),
  grantChange: z.boolean().optional(),
  secretRefs: z.record(z.string(), z.uuid()).optional(),
  registrationId: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()])),
  mapping: mappingChoicesSchema.optional(),
  mappingChange: z.boolean().optional(),
});
export const commitInputSchema = installInputSchema.extend({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

function human(caller: Caller) {
  if (!canApproveDestructive(caller.actor, caller.scopes))
    throw forbidden('only a human admin can approve extension installations');
}
function scope(caller: Caller, required: 'read' | 'schema:write') {
  if (!caller.scopes.includes('admin') && !caller.scopes.includes(required))
    throw forbidden(`extension operation requires ${required}`);
}
const conflict = (code: string, message: string) => new AppError(409, code, message);
const sameScopes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((scope) => b.includes(scope));

type Row = {
  suggestions_status?: ExtensionInstallation['suggestionsStatus'];
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  state: ExtensionInstallation['state'];
  generation: number;
  grant_generation: number;
  settings_revision: number;
  settings: ExtensionInstallation['settings'];
  granted_actor: ExtensionInstallation['grantedActor'];
  granted_scopes: ExtensionInstallation['grantedScopes'];
  granted_uses: ExtensionInstallation['grantedUses'];
  secret_names?: string[];
  connection_health: 'ok' | 'needs_reconnect' | 'degraded';
  last_error: string | null;
  created_by: ExtensionInstallation['createdBy'];
  mapping: StoredMapping;
  mapping_revision: number;
  upgrade_held_digest: string | null;
};

type Plan = Awaited<ReturnType<Extensions['plan']>>;

/** Whether disconnect cleanup is still running, which blocks a release change. */
async function cleanupPending(tx: Tx, installationId: string) {
  const [pending] = await tx`select 1 from extension_jobs where installation_id=${installationId}
    and trigger_kind='disconnect' and status in ('queued','running') limit 1`;
  return !!pending;
}

/** A row's stored mapping, tolerating rows written before the column had its shape. */
function storedMapping(row: Pick<Row, 'mapping'> | undefined): StoredMapping {
  return row?.mapping?.outputs ? row.mapping : EMPTY_MAPPING;
}

/** The approved mapping by current field names; a deleted target keeps its last label. */
export function presentMapping(
  schema: Awaited<ReturnType<typeof loadSchemaState>>,
  manifest: ExtensionManifest,
  stored: StoredMapping,
  revision: number,
  owned: (universalId: string) => boolean,
): ExtensionMappingView | undefined {
  const mapping = manifest.mapping;
  if (!mapping) return undefined;
  const object = schema.objects.find((o) => o.universalId === mapping.objectId);
  const lookup = mapping.lookup
    ? object?.fields.find((f) => f.universalId === mapping.lookup?.fieldId)
    : undefined;
  return {
    revision,
    ...(lookup
      ? {
          lookup: {
            name: lookup.name,
            status:
              lookup.status === 'active' && lookup.type === mapping.lookup?.type
                ? ('ok' as const)
                : ('missing' as const),
          },
        }
      : {}),
    outputs: mapping.outputs.map((output) => {
      const binding = stored.outputs[output.key];
      if (!binding)
        return { output: output.key, action: 'skip', contribution: false, status: 'ok' };
      const { status, field } = bindingStatus(object, output, binding.fieldUniversalId);
      return {
        output: output.key,
        action: 'existing',
        ...(field ? { field: { name: field.name, label: field.label, type: field.type } } : {}),
        contribution: owned(binding.fieldUniversalId),
        status,
      };
    }),
  };
}
/** `activation` is undefined when this process does not know the deployed executables. */
function present(
  r: Row,
  runtime?: RuntimeCatalog,
  activation?: ReadonlySet<string>,
): ExtensionInstallation {
  const resolution = runtime ? releaseAvailability(runtime, r, activation) : undefined;
  return {
    ...(resolution
      ? {
          runtimeAvailability: resolution.available
            ? { state: 'available' as const }
            : { state: 'unavailable' as const, code: resolution.code },
        }
      : {}),
    ...(r.suggestions_status ? { suggestionsStatus: r.suggestions_status } : {}),
    id: r.id,
    registrationId: r.registration_id,
    version: r.version,
    releaseDigest: r.release_digest,
    state: r.state,
    connectionHealth: r.connection_health,
    lastError: r.last_error,
    generation: r.generation,
    grantGeneration: r.grant_generation,
    settingsRevision: r.settings_revision,
    secrets: Object.fromEntries((r.secret_names ?? []).map((name) => [name, true])),
    settings: r.settings,
    grantedActor: r.granted_actor,
    grantedScopes: r.granted_scopes,
    grantedUses: r.granted_uses,
    createdBy: r.created_by,
  };
}

export class Extensions {
  constructor(
    private readonly sql: Sql,
    readonly catalog = new ExtensionCatalog(),
    readonly secrets?: SecretBroker,
    /** Release digests with a deployed executable; undefined when this process does not know. */
    private readonly deployed?: ReadonlySet<string>,
  ) {
    this.activation = deployed ?? new Set();
    this.connections = new MemberConnections(sql, catalog, secrets);
  }
  private readonly activation: ReadonlySet<string>;
  readonly connections: MemberConnections;
  private queue() {
    return new ExtensionQueue(this.sql, this.catalog.runtime);
  }

  async stageSecret(
    caller: Caller,
    input: {
      registrationId: string;
      version: string;
      installationId?: string;
      name: string;
      value: string;
    },
  ) {
    human(caller);
    const release = this.catalog.get(input.registrationId, input.version);
    if (
      !release.manifest.settings[input.name]?.secret ||
      release.manifest.settings[input.name]?.generated ||
      release.manifest.settings[input.name]?.level === 'connection'
    )
      throw new AppError(422, 'invalid_secret', 'setting is not a declared human-provided secret');
    if (!this.secrets)
      throw new AppError(503, 'connection_required', 'secret broker is not configured');
    return this.secrets.stage(caller, input);
  }

  async list(caller: Caller) {
    scope(caller, 'read');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      if (caller.run || caller.installation) {
        await lockSchemaShared(tx, caller.workspaceId);
        await admitCaller(tx, caller, false, 'runtime');
      }
      return {
        installations: (
          await tx<
            Row[]
          >`select i.*,(select case j.status when 'succeeded' then 'ready' when 'queued' then 'queued' when 'running' then 'running' else 'failed' end from extension_suggestions s join extension_jobs j on j.id=s.job_id where s.installation_id=i.id and s.release_digest=i.release_digest and j.generation=i.generation) as suggestions_status,retainer_extension_secret_names(i.id) as secret_names
            from extension_installations i ${caller.run || caller.installation ? tx`where i.id = ${caller.run?.installationId ?? caller.installation?.installationId ?? null}` : tx``} order by i.created_at, i.id`
        ).map((row) => present(row, this.catalog.runtime, this.deployed)),
      };
    });
  }
  async get(caller: Caller, id: string) {
    if (
      (caller.run || caller.installation) &&
      (caller.run?.installationId ?? caller.installation?.installationId) !== id
    )
      throw notFound('extension installation');
    scope(caller, 'read');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      if (caller.run || caller.installation) {
        await lockSchemaShared(tx, caller.workspaceId);
        await admitCaller(tx, caller, false, 'runtime');
      }
      const [row] = await tx<
        Row[]
      >`select i.*,(select case j.status when 'succeeded' then 'ready' when 'queued' then 'queued' when 'running' then 'running' else 'failed' end from extension_suggestions s join extension_jobs j on j.id=s.job_id where s.installation_id=i.id and s.release_digest=i.release_digest and j.generation=i.generation) as suggestions_status from extension_installations i where i.id = ${id}`;
      if (!row) throw notFound('extension installation');
      if (caller.run && caller.run.releaseDigest !== row.release_digest) {
        const [approval] = await tx<
          { settings: Row['settings'] }[]
        >`select settings from extension_access_approvals
          where installation_id=${id} and release_digest=${caller.run.releaseDigest}
          and generation=${row.generation} and settings_revision=${row.settings_revision}`;
        if (approval) row.settings = approval.settings;
      }
      if (caller.run?.connectionId) {
        const [connection] =
          await tx`select settings from extension_connections where id=${caller.run.connectionId} and installation_id=${id}`;
        if (!connection) throw notFound('member connection');
        row.settings = { ...row.settings, ...connection.settings };
      }
      const contributions = await tx<{ kind: string; universalId: string; elementId: string }[]>`
        select kind, universal_id as "universalId", element_id as "elementId"
        from extension_contributions where installation_id = ${id} order by kind, universal_id`;
      const manifest = this.catalog.find(row.registration_id, row.version)?.manifest;
      const mapping =
        manifest?.mapping &&
        presentMapping(
          await loadSchemaState(tx, caller.workspaceId),
          manifest,
          storedMapping(row),
          row.mapping_revision,
          (universalId) =>
            contributions.some((c) => c.kind === 'field' && c.universalId === universalId),
        );
      const [presence] = await tx<
        { names: string[] }[]
      >`select ${caller.run?.connectionId ? tx`retainer_connection_secret_names(${id}::uuid,${caller.run.connectionId}::uuid)` : tx`retainer_extension_secret_names(${id}::uuid)`} as names`;
      return {
        ...present(row, this.catalog.runtime, this.deployed),
        secrets: Object.fromEntries((presence?.names ?? []).map((name) => [name, true])),
        contributions,
        ...(mapping ? { mapping } : {}),
      };
    });
  }

  /** The installation's model use this month, for its Overview tab (model calls spec 3.4). */
  async usage(caller: Caller, id: string) {
    scope(caller, 'read');
    if (caller.run || caller.installation) throw notFound('extension installation');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const [row] = await tx`select 1 from extension_installations where id=${id}`;
      if (!row) throw notFound('extension installation');
      return { model: await installationMonthUsage(tx, id) };
    });
  }

  async runs(caller: Caller, id: string, limit = 50, cursor?: string, connectionId?: string) {
    scope(caller, 'read');
    if (
      (caller.run || caller.installation) &&
      (caller.run?.installationId ?? caller.installation?.installationId) !== id
    )
      throw notFound('extension installation');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError(400, 'invalid_request', 'limit must be between 1 and 100');
    let after: string | undefined;
    if (cursor) {
      const parsed = z.uuid().safeParse(Buffer.from(cursor, 'base64url').toString());
      if (!parsed.success) throw new AppError(400, 'invalid_request', 'invalid run cursor');
      after = parsed.data;
    }
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitCaller(tx, caller, false, 'runtime');
      const [installation] =
        await tx`select id,registration_id,version from extension_installations where id=${id}`;
      if (!installation) throw notFound('extension installation');
      const [member] =
        await tx`select 1 from extension_connections where installation_id=${id} limit 1`;
      const owner = caller.person?.id ?? (caller.actor.type === 'user' ? caller.actor.id : null);
      const all = canApproveDestructive(caller.actor, caller.scopes);
      const rows = await tx<
        {
          id: string;
          functionId: string;
          connectionId: string | null;
          status: string;
          attempt: number;
          generation: number;
          releaseDigest: string;
          code: string | null;
          createdAt: Date;
          updatedAt: Date;
        }[]
      >`
        select id,function_id as "functionId",connection_id as "connectionId",status,attempt,generation,release_digest as "releaseDigest",code,
          created_at as "createdAt",updated_at as "updatedAt" from extension_jobs where installation_id=${id}
          ${connectionId ? tx`and connection_id=${connectionId}` : tx``}
          ${caller.run ? tx`and connection_id is not distinct from ${caller.run.connectionId ?? null}::uuid` : tx``}
          ${member && !all && !caller.run ? tx`and connection_id in(select id from extension_connections where installation_id=${id} and owner_id=${owner})` : tx``}
          ${after ? tx`and id<${after}::uuid` : tx``} order by id desc limit ${limit + 1}`;
      const page = rows.slice(0, limit),
        last = page.at(-1);
      return {
        runs: page.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > limit && last ? Buffer.from(last.id).toString('base64url') : null,
      };
    });
  }

  private async plan(tx: Tx, caller: Caller, input: ExtensionInstallInput) {
    const release = this.catalog.get(input.registrationId, input.version);
    const manifest = release.manifest;
    const uses = releaseUses(manifest);
    if (Buffer.byteLength(JSON.stringify(input.settings)) > 65536)
      throw new AppError(413, 'quota_exceeded', 'settings exceed 64 KiB');
    for (const [key, value] of Object.entries(input.settings)) {
      const definition = manifest.settings[key];
      if (
        !definition ||
        definition.level === 'connection' ||
        definition.secret ||
        typeof value !== definition.type ||
        (definition.options && !definition.options.includes(String(value))) ||
        (definition.consent && value !== true)
      )
        throw new AppError(
          422,
          'invalid_settings',
          'unknown, secret or incorrectly typed setting',
          { key },
        );
    }
    for (const [key, definition] of Object.entries(manifest.settings)) {
      if (definition.secret || definition.level === 'connection') continue;
      if (definition.required && !Object.hasOwn(input.settings, key))
        throw new AppError(422, 'invalid_settings', 'required setting missing', { key });
    }
    const [workspace] = await tx<
      { schema_version: number }[]
    >`select schema_version from workspaces where id = ${caller.workspaceId}`;
    if (!workspace) throw notFound('workspace');
    const [existing] = await tx<
      Row[]
    >`select * from extension_installations where registration_id = ${input.registrationId}`;
    if (input.installationId && (!existing || existing.id !== input.installationId))
      throw notFound('extension installation');
    if (
      existing?.state === 'configuring' &&
      (!input.turnOn ||
        existing.version !== input.version ||
        existing.release_digest !== release.digest)
    )
      throw conflict(
        'installation_disabled',
        'review turn-on for the approved release, or cancel and start again',
      );
    if (
      input.turnOn &&
      (existing?.state !== 'configuring' ||
        !input.installationId ||
        input.accessOnly ||
        input.mappingChange ||
        input.reconnect)
    )
      throw conflict('installation_disabled', 'turn-on requires a configuring installation');
    if (input.mappingChange) {
      if (!existing || !input.installationId || existing.version !== input.version)
        throw conflict('upgrade_conflict', 'a mapping change applies to the installed release');
      if (['uninstalled', 'uninstalling'].includes(existing.state))
        throw conflict('installation_disabled', 'reinstall before changing the mapping');
      if (
        input.reconnect ||
        input.grantChange ||
        input.replaceSourceAccount ||
        Object.keys(input.secretRefs ?? {}).length
      )
        throw new AppError(
          400,
          'invalid_request',
          'a mapping change cannot change credentials or grants',
        );
      if (hash(input.settings) !== hash(existing.settings))
        throw conflict('stale_plan', 'settings changed; review the mapping again');
      if (!manifest.mapping || !input.mapping)
        throw new AppError(422, 'mapping_invalid', 'a mapping change needs the full mapping');
    }
    if (input.reconnect && input.mapping)
      throw new AppError(400, 'invalid_request', 'change the mapping separately from reconnect');
    if (input.reconnect && (!input.installationId || existing?.version !== input.version))
      throw conflict(
        'connection_required',
        'reconnect the current installed release; upgrade separately',
      );
    if (input.replaceSourceAccount && (!input.reconnect || !manifest.source))
      throw conflict(
        'connection_required',
        'source account replacement requires an explicit reconnect',
      );
    if (input.installationId && ['uninstalled', 'uninstalling'].includes(existing?.state ?? ''))
      throw conflict('upgrade_conflict', 'reinstall before upgrading');
    if (!input.installationId && existing && existing.state !== 'uninstalled')
      throw conflict('upgrade_conflict', 'installation exists; use a validated upgrade');
    // Reinstall may target any compatible catalog release: the additive plan below
    // reuses the retained schema bindings, and the suppression namespace is keyed
    // by registration, so an installed release that is gone never strands it.
    if (
      existing &&
      existing.state !== 'configuring' &&
      !input.reconnect &&
      Object.entries(manifest.settings).some(
        ([key, def]) => def.reconnect && hash(existing.settings[key]) !== hash(input.settings[key]),
      )
    )
      throw conflict('connection_required', 'account settings require explicit reconnect');
    const [approval] = existing
      ? await tx<
          { secret_refs: Record<string, string> }[]
        >`select secret_refs from extension_access_approvals
      where installation_id=${existing.id} and release_digest=${release.digest} and generation=${existing.generation}
      and settings_revision=${existing.settings_revision}`
      : [];
    const refs = { ...(input.accessOnly ? {} : approval?.secret_refs), ...input.secretRefs };
    const pending = await pendingSecrets(tx, Object.values(refs));
    if (pending.length !== Object.keys(refs).length)
      throw conflict(
        'connection_required',
        'a pending secret reference expired or was already used',
      );
    const draftId = existing?.id ?? pending[0]?.draft_installation_id;
    const [stored] = existing
      ? await tx<
          { names: string[] }[]
        >`select retainer_extension_secret_names(${existing.id}::uuid) as names`
      : [];
    // An upgrade may supply a secret the installation does not store: no
    // credential is being replaced, so it needs no reconnect. A stored one,
    // even if an intermediate release dropped its declaration, still does.
    const newSecrets = new Set<string>();
    if (existing && input.installationId && existing.version !== input.version)
      for (const [name, definition] of Object.entries(manifest.settings))
        if (
          definition.secret &&
          definition.level !== 'connection' &&
          !definition.generated &&
          !stored?.names.includes(name)
        )
          newSecrets.add(name);
    for (const [name, id] of Object.entries(refs)) {
      const definition = manifest.settings[name],
        staged = pending.find((p) => p.id === id);
      if (
        !definition?.secret ||
        definition.level === 'connection' ||
        definition.generated ||
        !staged ||
        staged.name !== name ||
        staged.registration_id !== input.registrationId ||
        staged.draft_installation_id !== draftId
      )
        throw conflict(
          'connection_required',
          'pending secret is not bound to this installation and setting',
        );
      if (
        existing &&
        !['configuring', 'uninstalled'].includes(existing.state) &&
        !input.reconnect &&
        !(input.installationId && newSecrets.has(name))
      )
        throw conflict('connection_required', 'credential changes require reconnect');
    }
    for (const [name, definition] of Object.entries(manifest.settings))
      if (
        definition.secret &&
        definition.level !== 'connection' &&
        definition.required &&
        !Object.hasOwn(refs, name) &&
        !stored?.names.includes(name)
      )
        throw conflict('connection_required', `required secret ${name} is missing`);
    const current = await loadSchemaState(tx, caller.workspaceId);
    if (
      existing &&
      ((manifest.requestedActor === 'integration' && existing.granted_actor === 'agent') ||
        manifest.scopes.some((scope) => !existing.granted_scopes.includes(scope)) ||
        uses.some((use) => !existing.granted_uses.includes(use))) &&
      !input.grantChange &&
      !input.turnOn &&
      !input.accessOnly &&
      !approval
    )
      throw conflict(
        'grant_required',
        'this release requires a separately approved grant increase',
      );
    const accessOnly =
      input.accessOnly === true ||
      (!input.installationId &&
        (!existing || existing.state === 'uninstalled') &&
        manifest.functions.some((fn) => fn.trigger.kind === 'configure'));
    if (accessOnly) {
      if (
        !manifest.functions.some((fn) => fn.trigger.kind === 'configure') ||
        input.mapping ||
        input.reconnect ||
        input.mappingChange ||
        (existing && existing.state !== 'uninstalled' && existing.state !== 'active')
      )
        throw new AppError(
          400,
          'invalid_request',
          'review access separately from schema and credential changes',
        );
      const preview: ExtensionPreview = {
        planDigest: hash({
          operation: 'access',
          workspace: caller.workspaceId,
          release: release.digest,
          schema: workspace.schema_version,
          generation: existing?.generation ?? 0,
          settingsRevision: existing?.settings_revision ?? 0,
          settings: input.settings,
          refs,
          draftId,
          uses,
        }),
        schemaVersion: workspace.schema_version,
        generation: existing?.generation ?? 0,
        releaseDigest: release.digest,
        operations: [],
        views: [],
        grants: { actor: manifest.requestedActor, scopes: ['read'], uses },
        warnings: [
          'Approving lets this extension read workspace records and use its declared secrets before turn-on. No schema changes or writes are approved.',
          ...(uses.includes('model') ? [MODEL_USE_NOTICE] : []),
        ],
      };
      return {
        preview,
        release,
        operations: [],
        existing,
        draftId,
        retired: new Set<string>(),
        mapped: {
          stored: EMPTY_MAPPING,
          operations: [],
          contributions: [],
          bindings: [],
          warnings: [],
        },
        accessOnly,
        refs,
      };
    }
    const owned = existing
      ? await tx<
          ContributionRow[]
        >`select kind, universal_id, element_id, definition from extension_contributions where installation_id = ${existing.id}`
      : [];
    const owns = (kind: string, id: string) =>
      owned.some((o) => o.kind === kind && o.universal_id === id);
    const targets = [
      ...manifest.schema.map((c) => (c.kind === 'object' ? c.definition.universalId : c.objectId)),
      ...manifest.views.map((v) => v.objectId),
      ...manifest.functions.flatMap((f) =>
        f.trigger.kind === 'change' ? [f.trigger.objectId] : [],
      ),
      ...(manifest.mapping ? [manifest.mapping.objectId] : []),
    ];
    const relationTargets = manifest.schema.flatMap((c) =>
      (c.kind === 'object' ? c.definition.fields : [c.definition]).flatMap((f) =>
        [f.settings?.targetObject, ...(f.settings?.targetObjects ?? [])].filter(
          (id): id is string => !!id,
        ),
      ),
    );
    if ([...targets, ...relationTargets].some((id) => HIDDEN_TYPE_IDS.has(id)))
      throw conflict('schema_binding_conflict', 'extensions cannot target internal memory types');
    const contributed = contributionOperations(current, manifest, owned);
    // A first install or a reinstall reviews the mapping afresh; everything
    // else carries the stored one over unless the input changes it.
    const fresh = !existing || ['configuring', 'uninstalled'].includes(existing.state);
    if (manifest.mapping && fresh && !input.mapping)
      throw new AppError(422, 'mapping_invalid', 'choose a field or skip for every output', {
        outputs: [{ output: '*', reason: 'missing_mapping' }],
      });
    const mapped = resolveMapping(
      current,
      manifest,
      input.mapping,
      fresh ? undefined : storedMapping(existing),
      owned,
    );
    const operations = [...contributed.operations, ...mapped.operations];
    const notices = [...contributed.notices, ...mapped.warnings];
    const planned = planSchemaChange(current, operations, 'workspace');
    const retired = retiredContributions(current, manifest, owned);
    const skippedViews = manifest.views.filter(
      (v) =>
        !owns('view', v.universalId) && [v.objectId, ...v.fieldIds].some((id) => retired.has(id)),
    );
    const viewActions = new Map<string, ExtensionPreview['views'][number]['action']>();
    const viewNotices: string[] = [];
    for (const view of manifest.views) {
      if (skippedViews.includes(view)) continue;
      const [manager] = await tx<
        { installation_id: string }[]
      >`select installation_id from extension_contributions
        where kind = 'view' and universal_id = ${view.universalId}`;
      if (manager && manager.installation_id !== existing?.id)
        throw conflict(
          'schema_binding_conflict',
          `view ${view.universalId} belongs to another installation`,
        );
      const retained = owned.find((c) => c.kind === 'view' && c.universal_id === view.universalId);
      if (retained) {
        // A view the workspace deleted stays deleted. Its contribution row (and
        // old base) is kept so the identity stays managed and is not recreated;
        // no base is stored for a view that no longer exists.
        const [present] = await tx`select 1 from views where id = ${retained.element_id}`;
        if (!present) {
          viewActions.set(view.universalId, 'deleted_workspace');
          viewNotices.push(`View ${view.name} was deleted in this workspace; it is not recreated.`);
          continue;
        }
        // The stored definition is the publisher base this view was last applied from.
        if (hash(retained.definition) === hash(view)) {
          viewActions.set(view.universalId, 'retain');
          continue;
        }
        if (retained.definition.objectId !== view.objectId)
          throw conflict(
            'upgrade_conflict',
            `view ${view.universalId} moved to another object; use a new view identity`,
          );
        if (
          await managedViewEdited(
            tx,
            caller.workspaceId,
            retained.element_id,
            retained.definition as ManagedView,
          )
        ) {
          viewActions.set(view.universalId, 'keep_workspace');
          viewNotices.push(
            `View ${view.name} keeps the version edited in this workspace; this release's changes to it are not applied.`,
          );
          continue;
        }
        if (view.fieldIds.some((id) => retired.has(id))) {
          viewActions.set(view.universalId, 'retain');
          viewNotices.push(
            `View ${view.name} keeps its current columns: this release adds fields that were deleted.`,
          );
          continue;
        }
        viewActions.set(view.universalId, 'update');
      } else viewActions.set(view.universalId, 'create');
      const object = planned.desired.objects.find(
        (o) => o.universalId === view.objectId && o.status === 'active',
      );
      if (
        !object ||
        view.fieldIds.some(
          (id) => !object.fields.some((f) => f.universalId === id && f.status === 'active'),
        )
      )
        throw conflict(
          'schema_binding_conflict',
          `view ${view.universalId} has unresolved schema identities`,
        );
    }
    for (const fn of manifest.functions) {
      if (fn.trigger.kind !== 'change') continue;
      const trigger = fn.trigger;
      const object = planned.desired.objects.find((o) => o.universalId === trigger.objectId);
      if (
        !retired.has(trigger.objectId) &&
        (!object ||
          trigger.fieldIds.some(
            (id) => !retired.has(id) && !object.fields.some((f) => f.universalId === id),
          ))
      )
        throw conflict(
          'schema_binding_conflict',
          `function ${fn.universalId} has unresolved schema identities`,
        );
    }
    const generation = existing?.generation ?? 0;
    if (
      manifest.source?.eventTypeIds.some(
        (id) =>
          !planned.desired.objects.some(
            (o) => o.universalId === id && o.class === 'event' && o.status === 'active',
          ),
      )
    )
      throw conflict(
        'schema_binding_conflict',
        'managed source event types must resolve to active event schema identities',
      );
    const preview: ExtensionPreview = {
      planDigest: hash({
        workspace: caller.workspaceId,
        schema: workspace.schema_version,
        generation,
        release: release.digest,
        settings: input.settings,
        settingsRevision: existing?.settings_revision ?? 0,
        secretRefs: refs,
        draftId,
        operation: input.turnOn
          ? 'turn-on'
          : input.mappingChange
            ? 'mapping'
            : input.installationId
              ? 'upgrade'
              : 'install',
        // The resolved targets by universal ID, so a rename or retype after
        // preview changes the digest.
        mapping: mapped.stored,
        runtimeReady: manifest.execution === 'standalone' || this.activation.has(release.digest),
        reconnect: input.reconnect === true,
        replaceSourceAccount: input.replaceSourceAccount === true,
        grantChange: input.grantChange === true,
        // Whether a contributed view was edited decides how it is applied.
        views: [...viewActions],
        currentGrants: existing
          ? {
              actor: existing.granted_actor,
              scopes: existing.granted_scopes,
              uses: existing.granted_uses,
            }
          : null,
        uses,
      }),
      schemaVersion: workspace.schema_version,
      generation,
      releaseDigest: release.digest,
      operations: planned.ops,
      views: manifest.views
        .filter((view) => !skippedViews.includes(view))
        .map((view) => ({
          universalId: view.universalId,
          name: view.name,
          action: viewActions.get(view.universalId) ?? 'retain',
        })),
      grants: {
        actor: manifest.requestedActor,
        scopes: manifest.scopes,
        uses,
      },
      ...(existing && input.grantChange
        ? {
            previousGrants: {
              actor: existing.granted_actor,
              scopes: existing.granted_scopes,
              uses: existing.granted_uses,
            },
          }
        : {}),
      ...(manifest.mapping ? { mapping: mapped.bindings } : {}),
      warnings: [
        ...skippedViews.map(
          (view) => `View ${view.name} is skipped: its object or fields were deleted.`,
        ),
        // Shown wherever model use is newly granted: a release without
        // configure grants it here, in its single approval.
        ...(uses.includes('model') &&
        (!existing ||
          ['configuring', 'uninstalled'].includes(existing.state) ||
          !existing.granted_uses.includes('model'))
          ? [MODEL_USE_NOTICE]
          : []),
        ...notices,
        ...viewNotices,
        ...(manifest.mapping && (fresh || input.mappingChange)
          ? [
              'The mapping applies to records created or changed from now on. Existing records are not filled in.',
            ]
          : []),
        ...(input.reconnect
          ? [
              input.replaceSourceAccount
                ? 'Reconnect stops current runs and retires the previous source account binding and callback addresses. Previously imported evidence stays in this workspace.'
                : 'Reconnect stops current runs and verifies the new credentials against the retained source account. A different account requires explicit account replacement.',
            ]
          : []),
        ...(manifest.source
          ? [
              `Provider content is shared with everyone in this Retainer workspace. Source identity: ${manifest.source.identity}.`,
              `Create people: ${input.settings.createPeople ?? manifest.createPeople}; source deletion: ${manifest.onSourceDelete}.`,
            ]
          : []),
        ...(manifest.execution === 'standalone' || this.activation.has(release.digest)
          ? []
          : [
              'Runtime activation is unavailable. This installation remains disabled and cannot ingest data.',
            ]),
      ],
    };
    return { preview, release, operations, existing, draftId, retired, mapped, accessOnly, refs };
  }

  async preview(caller: Caller, input: ExtensionInstallInput) {
    scope(caller, 'schema:write');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await lockInstallation(tx, caller.workspaceId, input.registrationId);
      return (await this.plan(tx, caller, input)).preview;
    });
  }

  async install(
    caller: Caller,
    input: ExtensionInstallInput & { planDigest: string },
    key: string,
  ) {
    human(caller);
    scope(caller, 'schema:write');
    if (!key || key.length > 200)
      throw new AppError(
        400,
        'invalid_request',
        'Idempotency-Key of at most 200 characters required',
      );
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockPrivacyShared(tx, caller.workspaceId);
      await lockSchemaExclusive(tx, caller.workspaceId);
      await lockInstallation(tx, caller.workspaceId, input.registrationId);
      const requestHash = hash({ input, actor: caller.actor });
      const [receipt] = await tx<
        {
          request_hash: string;
          generation: number;
          response: ExtensionInstallation;
          current_generation: number;
        }[]
      >`
        select r.*, i.generation as current_generation from extension_receipts r
        join extension_installations i on i.id = r.installation_id and i.workspace_id = r.workspace_id
        where r.key = ${key}`;
      if (receipt) {
        if (receipt.request_hash !== requestHash)
          throw conflict('idempotency_conflict', 'idempotency key was used for another request');
        if (receipt.generation !== receipt.current_generation)
          throw conflict('stale_plan', 'installation generation changed since this request');
        return receipt.response;
      }
      const plan = await this.plan(tx, caller, input);
      if (plan.preview.planDigest !== input.planDigest)
        throw conflict('stale_plan', 'schema, settings or installation changed; preview again');
      return this.commitPlan(tx, caller, input, plan, key, requestHash);
    });
  }

  /**
   * Commits a validated plan: applies its schema, adopts the release and
   * queues setup. A reviewed install or upgrade and an automatic upgrade
   * (auto-upgrade.ts) both end here, under the same locks.
   */
  private async commitPlan(
    tx: Tx,
    caller: Caller,
    input: ExtensionInstallInput,
    plan: Plan,
    key: string,
    requestHash: string,
  ) {
    if (plan.accessOnly) return this.commitAccess(tx, caller, input, plan, key, requestHash);
    if (input.reconnect && plan.operations.length)
      throw conflict(
        'schema_binding_conflict',
        'repair schema bindings through a validated upgrade before reconnecting',
      );
    if (plan.existing && !input.mappingChange) {
      if (await cleanupPending(tx, plan.existing.id))
        throw new AppError(
          409,
          'cleanup_pending',
          'wait for disconnect cleanup before changing the release',
          {
            retryAfterSeconds: 15,
          },
        );
    }
    const result = await runSchemaChange(tx, {
      workspaceId: caller.workspaceId,
      actor: caller.actor,
      scopes: caller.scopes,
      operations: plan.operations,
      owner: 'workspace',
      reason: `Install extension ${plan.release.manifest.name}`,
    });
    if (result.status !== 'applied' && result.status !== 'unchanged')
      throw conflict('schema_binding_conflict', 'extension schema could not be applied');
    if (input.mappingChange && plan.existing)
      return this.commitMapping(tx, caller, plan, key, requestHash);
    if (plan.existing) {
      await cancelRuns(tx, plan.existing.id);
      if (input.reconnect || input.replaceSourceAccount)
        await tx`delete from source_sync_state where installation_id=${plan.existing.id}`;
    }
    const manifest = plan.release.manifest;
    const standalone = manifest.execution === 'standalone';
    const ready = standalone || this.activation.has(plan.release.digest);
    const setupKind =
      input.installationId && !input.reconnect && !input.turnOn ? 'upgrade' : 'install';
    const state = standalone
      ? 'active'
      : ready
        ? setupKind === 'upgrade'
          ? 'upgrading'
          : 'installing'
        : 'disabled';
    // Standalone credentials survive a release change unless what they were
    // granted changes: the actor, the scopes, the execution model, the pinned
    // OAuth client (a release may drop it; the catalog only forbids switching)
    // or the account. The installed release is pinned, so this is the only
    // path by which its client can change.
    const previous = plan.existing
      ? resolveRelease(this.catalog.runtime, plan.existing)
      : undefined;
    const regrant =
      !!plan.existing &&
      (input.reconnect === true ||
        input.replaceSourceAccount === true ||
        plan.existing.granted_actor !== manifest.requestedActor ||
        !sameScopes(plan.existing.granted_scopes, manifest.scopes) ||
        !previous?.available ||
        previous.manifest.execution !== manifest.execution ||
        previous.manifest.oauthClientId !== manifest.oauthClientId);
    const [row] = await tx<Row[]>`insert into extension_installations
      (id,workspace_id, registration_id, version, release_digest, granted_actor, granted_scopes, granted_uses, settings, created_by, state, setup_kind, mapping)
      values (${plan.draftId ?? tx`uuidv7()`},${caller.workspaceId}, ${manifest.universalId}, ${manifest.version}, ${plan.release.digest},
        ${manifest.requestedActor}, ${tx.json(manifest.scopes)}, ${tx.json(releaseUses(manifest))}, ${tx.json(input.settings)}, ${tx.json(caller.actor)}, ${state}, ${setupKind},
        ${tx.json(jsonValue(plan.mapped.stored))})
      on conflict (workspace_id, registration_id) do update set state = excluded.state,setup_kind=excluded.setup_kind,
        last_error=null,connection_health='needs_reconnect',activated_at=null,cleanup_deadline=null,
        version = excluded.version, release_digest = excluded.release_digest,granted_scopes=excluded.granted_scopes,granted_uses=excluded.granted_uses,granted_actor=excluded.granted_actor,
        generation = extension_installations.generation + 1, settings = excluded.settings,
        grant_generation = extension_installations.grant_generation + ${regrant ? 1 : 0},
        settings_revision = extension_installations.settings_revision + 1, mapping = excluded.mapping,
        mapping_revision = extension_installations.mapping_revision
          + case when extension_installations.mapping is distinct from excluded.mapping then 1 else 0 end,
        updated_at = now()
      returning *`;
    if (!row) throw new Error('installation insert returned no row');
    if (manifest.connection === 'member') {
      // Membership removal can run before setup finishes. Cache the hook
      // with the release adoption, under the same installation lock.
      const disconnect =
        manifest.functions.find((fn) => fn.trigger.kind === 'disconnect')?.universalId ?? null;
      await tx`update extension_connections set disconnect_function_id=${disconnect}
        where installation_id=${row.id} and state<>'disconnected'`;
    }
    if (input.replaceSourceAccount) {
      await tx`delete from source_bindings where installation_id=${row.id}`;
      await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${row.id} and state<>'retired'`;
    }
    for (const [name, reference] of Object.entries(plan.refs)) {
      const [adopted] = await tx<
        { ok: boolean }[]
      >`select retainer_adopt_extension_secret(${reference}::uuid,${row.id}::uuid,${manifest.universalId}::uuid,${name}) as ok`;
      if (!adopted?.ok)
        throw conflict(
          'connection_required',
          'pending secret expired before installation completed',
        );
    }
    const schema = await loadSchemaState(tx, caller.workspaceId);
    const save = (kind: string, universalId: string, elementId: string, definition: unknown) =>
      saveContribution(tx, caller.workspaceId, row.id, kind, universalId, elementId, definition);
    await saveMappingContributions(tx, caller.workspaceId, row.id, schema, plan.mapped);
    for (const c of manifest.schema) {
      const element =
        c.kind === 'object'
          ? schema.objects.find((o) => o.universalId === c.definition.universalId)
          : schema.objects
              .flatMap((o) => o.fields)
              .find((f) => f.universalId === c.definition.universalId);
      if (!element?.id && plan.retired.has(c.definition.universalId)) continue;
      if (!element?.id)
        throw conflict('schema_binding_conflict', 'contribution missing after apply');
      await save(c.kind, c.definition.universalId, element.id, c.definition);
      if (c.kind === 'object') {
        const object = schema.objects.find((o) => o.id === element.id);
        for (const f of c.definition.fields) {
          const field = object?.fields.find((v) => v.universalId === f.universalId);
          if (!field?.id && plan.retired.has(f.universalId)) continue;
          if (!field?.id) throw conflict('schema_binding_conflict', 'contributed field missing');
          await save('field', f.universalId, field.id, f);
        }
      }
    }
    for (const view of manifest.views) {
      const action = plan.preview.views.find((v) => v.universalId === view.universalId)?.action;
      if (!action) continue;
      const [retained] = await tx<
        { element_id: string; definition: ManagedView }[]
      >`select element_id, definition from extension_contributions where kind = 'view' and universal_id = ${view.universalId}`;
      if (retained && !plan.existing)
        throw conflict('schema_binding_conflict', 'view identity already managed');
      if (retained) {
        if (action === 'retain' || action === 'deleted_workspace') continue;
        if (
          action === 'update' &&
          !(await replaceManagedView(tx, caller, retained.element_id, retained.definition, view))
        )
          throw conflict('stale_plan', 'a contributed view changed; preview again');
        // Kept or replaced, the publisher base moves to this release.
        await save('view', view.universalId, retained.element_id, view);
        continue;
      }
      const object = schema.objects.find((o) => o.universalId === view.objectId);
      if (!object) throw conflict('schema_binding_conflict', 'view object missing');
      const created = await createViewInTransaction(tx, caller, object.nameSingular, {
        name: view.name,
        kind: 'table',
        visibility: 'workspace',
        columns: {
          order: view.fieldIds.map(
            (id) => object.fields.find((f) => f.universalId === id)?.name ?? '',
          ),
        },
      });
      await save('view', view.universalId, created.id, view);
    }
    // A person moving an installation back to an older release has chosen it:
    // the newest release is held, so an automatic upgrade does not undo that.
    // Any other change of release by a person clears an earlier hold.
    const previousRelease =
      plan.existing && plan.existing.state !== 'uninstalled' ? plan.existing.version : undefined;
    if (
      caller.actor.type !== 'system' &&
      previousRelease !== undefined &&
      previousRelease !== manifest.version
    ) {
      const newest = newestReleases(this.catalog.list()).get(manifest.universalId);
      const held =
        compareVersions(manifest.version, previousRelease) < 0 && newest ? newest.digest : null;
      await tx`update extension_installations set upgrade_held_digest = ${held} where id = ${row.id}`;
      row.upgrade_held_digest = held;
    }
    const [presence] = await tx<
      { names: string[] }[]
    >`select retainer_extension_secret_names(${row.id}::uuid) as names`;
    row.secret_names = presence?.names ?? [];
    if (standalone) {
      await tx`update extension_installations set connection_health='ok',activated_at=clock_timestamp() where id=${row.id}`;
      row.connection_health = 'ok';
    }
    // Setup learns which release it replaces; a first install or a reinstall after
    // uninstall starts fresh (null).
    const previousVersion =
      plan.existing && !['configuring', 'uninstalled'].includes(plan.existing.state)
        ? plan.existing.version
        : null;
    if (ready && !standalone)
      await this.queue().enqueueLifecycle(
        tx,
        caller.workspaceId,
        row.id,
        'install',
        previousVersion,
      );
    await tx`delete from extension_suggestions where installation_id=${row.id}`;
    await tx`delete from extension_access_approvals where installation_id=${row.id}`;
    const response = present(row);
    await tx`insert into extension_receipts (workspace_id, key, request_hash, installation_id, generation, response)
      values (${caller.workspaceId}, ${key}, ${requestHash}, ${row.id}, ${row.generation}, ${tx.json(jsonValue(response))})`;
    return response;
  }

  /**
   * Commits a reviewed mapping change (spec 3.3). The installation stays in
   * its state and setup does not re-run. The generation advances, so current
   * attempts lose write access, and their work and every queued job move to
   * the new generation: they hold no mapping and read it when they run.
   */
  private async commitMapping(
    tx: Tx,
    caller: Caller,
    plan: Plan,
    key: string,
    requestHash: string,
  ) {
    const existing = plan.existing as Row;
    const schema = await loadSchemaState(tx, caller.workspaceId);
    await saveMappingContributions(tx, caller.workspaceId, existing.id, schema, plan.mapped);
    const [row] = await tx<Row[]>`update extension_installations
      set mapping = ${tx.json(jsonValue(plan.mapped.stored))}, mapping_revision = mapping_revision + 1,
        generation = generation + 1, updated_at = now(),
        -- A remap repairs a broken binding, so its diagnostic goes with it.
        connection_health = case when last_error = 'schema_binding_conflict' then 'ok' else connection_health end,
        last_error = case when last_error = 'schema_binding_conflict' then null else last_error end
      where id = ${existing.id} returning *`;
    if (!row) throw notFound('extension installation');
    await tx`update change_dispatch set generation = ${row.generation}
      where installation_id = ${row.id} and generation = ${existing.generation}`;
    await tx`update extension_attempts set status = 'cancelled', code = 'mapping_changed', finished_at = now()
      where finished_at is null and job_id in (select id from extension_jobs where installation_id = ${row.id})`;
    await tx`update extension_jobs set status='cancelled',code='mapping_changed',lease_owner=null,lease_until=null,run_until=null where installation_id=${row.id} and trigger_kind='configure' and status in ('queued','running')`;
    await tx`update extension_jobs set generation = ${row.generation}, status = 'queued', lease_owner = null,
        lease_until = null, run_until = null, fence = fence + 1, available_at = now(), updated_at = now()
      where installation_id = ${row.id} and status in ('queued', 'running')`;
    const [presence] = await tx<
      { names: string[] }[]
    >`select retainer_extension_secret_names(${row.id}::uuid) as names`;
    row.secret_names = presence?.names ?? [];
    await tx`delete from extension_suggestions where installation_id=${row.id}`;
    await tx`delete from extension_access_approvals where installation_id=${row.id}`;
    const response = present(row);
    await tx`insert into extension_receipts (workspace_id, key, request_hash, installation_id, generation, response)
      values (${caller.workspaceId}, ${key}, ${requestHash}, ${row.id}, ${row.generation}, ${tx.json(jsonValue(response))})`;
    return response;
  }

  /** The release each registration upgrades to on its own, when this process can run it. */
  upgradeTargets(): UpgradeTarget[] {
    // The catalog and the deployed releases are fixed for this process.
    this.targets ??= upgradeTargets(
      this.catalog.list(),
      (release) =>
        release.manifest.execution === 'standalone' || this.activation.has(release.digest),
    );
    return this.targets;
  }
  private targets: UpgradeTarget[] | undefined;

  /**
   * One automatic-upgrade pass (auto-upgrade.ts): every active installation
   * behind its target either upgrades as the system actor or is held for an
   * admin. Discovery runs as the executor; each upgrade runs in its workspace.
   */
  async upgradeDue(discoverySql: Sql, limit = 50) {
    const targets = this.upgradeTargets();
    const result = { upgraded: 0, held: 0, failed: 0 };
    if (!targets.length) return result;
    const due = await discoverySql<{ workspace_id: string; installation_id: string }[]>`
      select * from retainer_extension_upgrades_due(${limit},
        ${targets.map((t) => t.registrationId)}::uuid[], ${targets.map((t) => t.digest)}::text[])`;
    // Discovery takes the oldest rows first. A row that made no progress (it
    // failed, or a re-check under the lock skipped it) moves behind the rest,
    // so such rows never starve the others.
    const rotate = (item: (typeof due)[number]) =>
      inWorkspace(this.sql, item.workspace_id, async (tx) => {
        await tx`update extension_installations set updated_at = now() where id = ${item.installation_id}`;
      }).catch(() => {});
    for (const item of due) {
      // One installation's failure never stops the pass or the executor.
      try {
        const outcome = await this.autoUpgrade(item.workspace_id, item.installation_id, targets);
        if (outcome === 'upgraded') result.upgraded++;
        else if (outcome === 'held') result.held++;
        else await rotate(item);
      } catch (error) {
        result.failed++;
        const code = error instanceof AppError ? error.code : 'internal';
        log.error(
          `Automatic upgrade of extension installation ${item.installation_id} in workspace ${item.workspace_id} failed (${code}).`,
        );
        await rotate(item);
      }
    }
    return result;
  }

  /** Upgrades one installation to its target, holds it for an admin, or skips it. */
  async autoUpgrade(
    workspaceId: string,
    installationId: string,
    targets: readonly UpgradeTarget[] = this.upgradeTargets(),
  ): Promise<'upgraded' | 'held' | 'skipped'> {
    const caller: Caller = {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: ['read', 'write', 'schema:write', 'admin'],
    };
    type Candidate = Pick<
      Row,
      'id' | 'registration_id' | 'version' | 'state' | 'release_digest' | 'upgrade_held_digest'
    >;
    // Whether there is anything to do, checked again under the locks.
    const due = async (tx: Tx, row: Candidate | undefined) => {
      const target = targets.find((t) => t.registrationId === row?.registration_id);
      if (
        !row ||
        !target ||
        row.state !== 'active' ||
        row.release_digest === target.digest ||
        row.upgrade_held_digest === target.digest ||
        // Only forward: a newer installed release is a person's choice.
        compareVersions(target.version, row.version) <= 0 ||
        (await cleanupPending(tx, row.id))
      )
        return undefined;
      return target;
    };
    return inWorkspace(this.sql, workspaceId, async (tx) => {
      // Before the exclusive schema lock, which blocks the workspace's writes.
      const [candidate] = await tx<Candidate[]>`select id, registration_id, version,
        state, release_digest, upgrade_held_digest from extension_installations where id = ${installationId}`;
      if (!candidate || !(await due(tx, candidate))) return 'skipped';
      await lockPrivacyShared(tx, workspaceId);
      await lockSchemaExclusive(tx, workspaceId);
      await lockInstallation(tx, workspaceId, candidate.registration_id);
      // Re-read under the lock: an admin may have upgraded, disabled or held it.
      const [current] = await tx<
        Row[]
      >`select * from extension_installations where id = ${installationId}`;
      const target = await due(tx, current);
      if (!current || !target) return 'skipped';
      const name = this.catalog.get(target.registrationId, target.version).manifest.name;
      const hold = async (reason: string) => {
        await tx`update extension_installations set upgrade_held_digest = ${target.digest}
          where id = ${current.id}`;
        log.info(
          `Extension ${name} ${current.version} -> ${target.version} in workspace ${workspaceId}: held for an admin (${reason}).`,
        );
        return 'held' as const;
      };
      const input: ExtensionInstallInput = {
        registrationId: target.registrationId,
        version: target.version,
        installationId: current.id,
        settings: current.settings,
      };
      let plan: Plan;
      try {
        plan = await this.plan(tx, caller, input);
      } catch (error) {
        // A plan an admin could not approve unchanged either (more access, a
        // missing secret, a binding conflict) is held with its code.
        if (error instanceof AppError) return hold(error.code);
        throw error;
      }
      const previous = resolveRelease(this.catalog.runtime, current);
      const reason = holdReason({
        previous: previous?.available ? previous.manifest : undefined,
        next: plan.release.manifest,
        schemaOperations: plan.operations.length,
        viewActions: plan.preview.views.map((view) => view.action),
        storedMapping: storedMapping(current),
        plannedMapping: plan.mapped.stored,
      });
      if (reason) return hold(reason);
      // Unique per generation: an installation moved back by a person and
      // forward again later gets a new receipt.
      const key = `auto-upgrade:${current.id}:${current.generation}:${target.digest}`;
      await this.commitPlan(tx, caller, input, plan, key, hash({ input, actor: caller.actor }));
      log.info(
        `Extension ${name} upgraded from ${current.version} to ${target.version} in workspace ${workspaceId}.`,
      );
      return 'upgraded';
    });
  }

  private async commitAccess(
    tx: Tx,
    caller: Caller,
    input: ExtensionInstallInput,
    plan: Plan,
    key: string,
    requestHash: string,
  ) {
    const manifest = plan.release.manifest;
    let row = plan.existing;
    if (row?.state === 'active') {
      await this.clearConfigure(tx, row.id, plan.release.digest);
      await tx`insert into extension_access_approvals(workspace_id,installation_id,release_digest,generation,settings_revision,scopes,uses,actor,secret_refs,settings,approved_by)
        values(${caller.workspaceId},${row.id},${plan.release.digest},${row.generation},${row.settings_revision},${tx.json(manifest.scopes)},
          ${tx.json(releaseUses(manifest))},${manifest.requestedActor},${tx.json(plan.refs)},${tx.json(input.settings)},${tx.json(caller.actor)})
        on conflict(workspace_id,installation_id,release_digest) do update set generation=excluded.generation,
          settings_revision=excluded.settings_revision,scopes=excluded.scopes,uses=excluded.uses,actor=excluded.actor,secret_refs=excluded.secret_refs,
          settings=excluded.settings,approved_by=excluded.approved_by,approved_at=now()`;
    } else {
      if (row) await cancelRuns(tx, row.id);
      const [created] = await tx<
        Row[]
      >`insert into extension_installations(id,workspace_id,registration_id,version,release_digest,granted_actor,granted_scopes,granted_uses,settings,created_by,state)
        values(${plan.draftId ?? tx`uuidv7()`},${caller.workspaceId},${manifest.universalId},${manifest.version},${plan.release.digest},
          ${manifest.requestedActor},${tx.json(['read'])},${tx.json(releaseUses(manifest))},${tx.json(input.settings)},${tx.json(caller.actor)},'configuring')
        on conflict(workspace_id,registration_id) do update set version=excluded.version,release_digest=excluded.release_digest,
          granted_actor=excluded.granted_actor,granted_scopes=excluded.granted_scopes,granted_uses=excluded.granted_uses,settings=excluded.settings,state='configuring',
          created_by=excluded.created_by,generation=extension_installations.generation+1,settings_revision=extension_installations.settings_revision+1,
          last_error=null,activated_at=null,cleanup_deadline=null,created_at=now(),updated_at=now() returning *`;
      if (!created) throw new Error('installation insert returned no row');
      row = created;
      for (const [name, reference] of Object.entries(plan.refs)) {
        const [adopted] =
          await tx`select retainer_adopt_extension_secret(${reference}::uuid,${row.id}::uuid,${manifest.universalId}::uuid,${name}) as ok`;
        if (!adopted?.ok) throw conflict('connection_required', 'pending secret expired');
      }
    }
    await this.configureInTransaction(tx, caller, row, plan.release.manifest.version);
    const response = present(row);
    await tx`insert into extension_receipts(workspace_id,key,request_hash,installation_id,generation,response)
      values(${caller.workspaceId},${key},${requestHash},${row.id},${row.generation},${tx.json(jsonValue(response))})`;
    return response;
  }

  private async configureInTransaction(tx: Tx, caller: Caller, row: Row, version: string) {
    const target = this.catalog.get(row.registration_id, version);
    if (!['configuring', 'active'].includes(row.state))
      throw conflict('installation_disabled', 'configure requires active or configuring');
    if (row.state === 'configuring' && target.digest !== row.release_digest)
      throw conflict('grant_required', 'cancel and approve access to the new release first');
    if (target.digest !== row.release_digest) {
      const [approval] =
        await tx`select 1 from extension_access_approvals where installation_id=${row.id}
        and release_digest=${target.digest} and generation=${row.generation} and settings_revision=${row.settings_revision}`;
      if (!approval) {
        const previous = this.catalog.get(row.registration_id, row.version).manifest;
        const increased =
          target.manifest.requestedActor !== row.granted_actor ||
          target.manifest.scopes.some((s) => !row.granted_scopes.includes(s)) ||
          releaseUses(target.manifest).some((use) => !row.granted_uses.includes(use)) ||
          target.manifest.functions
            .filter((f) => f.trigger.kind === 'configure')
            .some((f) =>
              functionSecrets(target.manifest, f).some((s) => !previous.settings[s]?.secret),
            );
        if (increased)
          throw conflict('grant_required', 'approve target release access before configure');
        await tx`insert into extension_access_approvals(workspace_id,installation_id,release_digest,generation,settings_revision,scopes,uses,actor,settings,approved_by)
          values(${caller.workspaceId},${row.id},${target.digest},${row.generation},${row.settings_revision},${tx.json(target.manifest.scopes)},
            ${tx.json(releaseUses(target.manifest))},${target.manifest.requestedActor},${tx.json(row.settings)},${tx.json(caller.actor)})
          on conflict do nothing`;
      }
    }
    return this.queue().enqueueConfigure(tx, caller.workspaceId, row.id, target.digest, {
      reason:
        row.state === 'configuring'
          ? 'install'
          : target.digest !== row.release_digest
            ? 'upgrade'
            : 'requested',
      previousVersion: target.digest !== row.release_digest ? row.version : null,
      newOutputs:
        target.manifest.mapping?.outputs
          .filter((o) => !storedMapping(row).outputs[o.key])
          .map((o) => o.key) ?? [],
    });
  }

  suggestions(caller: Caller, id: string, version?: string) {
    scope(caller, 'read');
    return getSuggestions(this.sql, this.catalog, caller, id, version);
  }

  private async clearConfigure(tx: Tx, id: string, digest: string) {
    await tx`update extension_attempts set status='cancelled',code='configure_cancelled',finished_at=now()
      where finished_at is null and job_id in(select id from extension_jobs where installation_id=${id} and release_digest=${digest} and trigger_kind='configure')`;
    await tx`update extension_jobs set status='cancelled',code='configure_cancelled',lease_owner=null,lease_until=null,run_until=null,fence=fence+1
      where installation_id=${id} and release_digest=${digest} and trigger_kind='configure' and status in ('queued','running')`;
    await tx`delete from extension_suggestions where installation_id=${id} and release_digest=${digest}`;
    await tx`delete from extension_access_approvals where installation_id=${id} and release_digest=${digest}`;
  }

  async cancelConfigure(caller: Caller, id: string, version?: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      const release = this.catalog.get(candidate.registration_id, version ?? candidate.version);
      await this.clearConfigure(tx, id, release.digest);
      return { cancelled: true };
    });
  }

  async configure(caller: Caller, id: string, version?: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      const [row] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!row) throw notFound('extension installation');
      return this.configureInTransaction(tx, caller, row, version ?? row.version);
    });
  }

  async issueKey(
    caller: Caller,
    id: string,
    input: { expectedGeneration: number; scopes: ('read' | 'write')[] },
  ) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      const [current] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!current) throw notFound('extension installation');
      if (current.state !== 'active' || current.generation !== input.expectedGeneration)
        throw conflict('stale_plan', 'installation changed before issuing its credential');
      if (
        this.catalog.get(current.registration_id, current.version).manifest.execution !==
        'standalone'
      )
        throw new AppError(
          403,
          'forbidden',
          'only a standalone installation may receive an installation key',
        );
      if (
        !input.scopes.length ||
        new Set(input.scopes).size !== input.scopes.length ||
        input.scopes.some((scope) => !current.granted_scopes.includes(scope))
      )
        throw new AppError(
          422,
          'invalid_scopes',
          'credential scopes exceed the approved installation',
        );
      const [count] = await tx<
        { count: number }[]
      >`select count(*)::int as count from extension_credentials where installation_id=${id} and kind='key' and generation=${current.grant_generation} and revoked_at is null`;
      if ((count?.count ?? 0) >= 20)
        throw new AppError(
          429,
          'quota_exceeded',
          'revoke an unused installation key before issuing another',
        );
      const key = mintInstallationKey();
      const [credential] =
        await tx`insert into extension_credentials(workspace_id,installation_id,generation,kind,key_hash,prefix,scopes,created_by)
        values(${caller.workspaceId},${id},${current.grant_generation},'key',${hashInstallationKey(key)},${key.slice(0, 12)},${tx.json(input.scopes)},${tx.json(caller.actor)}) returning id,prefix,created_at`;
      if (!credential) throw new Error('installation credential insert returned no row');
      return {
        id: credential.id,
        key,
        prefix: credential.prefix,
        scopes: input.scopes,
        generation: current.grant_generation,
        createdAt: credential.created_at.toISOString(),
      };
    });
  }
  async credentials(caller: Caller, id: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [installation] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!installation) throw notFound('extension installation');
      const rows =
        await tx`select id,kind,prefix,client_id,generation,scopes,created_at,revoked_at,pending from extension_credentials where installation_id=${id} order by created_at,id`;
      return {
        credentials: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          prefix: r.prefix,
          clientId: r.client_id,
          generation: r.generation,
          scopes: r.scopes,
          createdAt: r.created_at.toISOString(),
          revokedAt: r.revoked_at?.toISOString() ?? null,
          active:
            !r.revoked_at &&
            !r.pending &&
            r.generation === installation.grant_generation &&
            installation.state === 'active',
        })),
      };
    });
  }
  async revokeCredential(caller: Caller, id: string, credentialId: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [installation] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!installation) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, installation.registration_id);
      const [row] =
        await tx`update extension_credentials set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=${credentialId} and installation_id=${id} returning id`;
      if (!row) throw notFound('installation credential');
      await tx`delete from oauth_grant_references where credential_id=${credentialId} and kind='installation'`;
      return { revoked: true };
    });
  }

  async updateSettings(
    caller: Caller,
    id: string,
    input: { expectedRevision: number; settings: ExtensionInstallInput['settings'] },
  ) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id = ${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      const [current] = await tx<Row[]>`select * from extension_installations where id = ${id}`;
      if (!current) throw notFound('extension installation');
      // Uninstalling has already retired secrets and webhooks; a settings change
      // must not cancel its cleanup or turn it back into a disabled installation.
      if (current.state === 'configuring')
        throw conflict('installation_disabled', 'finish setup before changing settings');
      if (current.state === 'uninstalling')
        throw conflict('installation_disabled', 'uninstall is in progress; reinstall afterward');
      if (current.state === 'uninstalled')
        throw conflict('installation_disabled', 'reinstall before changing settings');
      if (current.settings_revision !== input.expectedRevision)
        throw conflict('stale_plan', 'settings revision changed');
      const release = this.catalog.get(current.registration_id, current.version);
      if (hash(input.settings) === hash(current.settings)) return present(current);
      // Account/credential changes need a reconnect flow; never treat them as ordinary settings.
      for (const [key, definition] of Object.entries(release.manifest.settings)) {
        if (
          (definition.secret && Object.hasOwn(input.settings, key)) ||
          (definition.reconnect && hash(current.settings[key]) !== hash(input.settings[key]))
        )
          throw conflict(
            'connection_required',
            'use reconnect to change provider credentials or account settings',
          );
        if (
          definition.level !== 'connection' &&
          !definition.secret &&
          definition.required &&
          !Object.hasOwn(input.settings, key)
        )
          throw new AppError(422, 'invalid_settings', 'required setting missing', { key });
      }
      if (Buffer.byteLength(JSON.stringify(input.settings)) > 65536)
        throw new AppError(413, 'quota_exceeded', 'settings exceed 64 KiB');
      for (const [key, value] of Object.entries(input.settings)) {
        const definition = release.manifest.settings[key];
        if (
          !definition ||
          definition.level === 'connection' ||
          typeof value !== definition.type ||
          definition.secret ||
          (definition.options && !definition.options.includes(String(value))) ||
          (definition.consent && value !== true)
        )
          throw new AppError(
            422,
            'invalid_settings',
            'unknown, secret or incorrectly typed setting',
            { key },
          );
      }
      // Ordinary settings update in place: runs started under the old values are
      // fenced (new generation), but the installation stays enabled and its
      // standalone credentials keep their grant.
      await cancelRuns(tx, id, current.generation + 1);
      // The scan cursor and any open enumeration were computed under the old
      // settings (a backfill window, a filter). Resuming from them could skip
      // items the new settings bring into scope, so the next scan starts over.
      await tx`delete from source_sync_state where installation_id=${id}`;
      const standalone = release.manifest.execution === 'standalone';
      // Hosted setup binds the source account and webhooks to a generation, so a
      // running installation re-runs setup at the new one, exactly like an upgrade.
      const running = !standalone && ['active', 'installing', 'upgrading'].includes(current.state);
      const ready = running && this.activation.has(current.release_digest);
      const state: Row['state'] = !running
        ? current.state
        : !ready
          ? 'disabled'
          : current.state === 'installing'
            ? 'installing'
            : 'upgrading';
      const [updated] = await tx<
        Row[]
      >`update extension_installations set settings = ${tx.json(input.settings)},
        settings_revision = settings_revision + 1, generation = generation + 1, state = ${state},
        setup_kind = case when ${state} = 'upgrading' then 'upgrade' else setup_kind end,
        last_error = case when ${running} then null else last_error end,
        connection_health = case when ${running} then 'needs_reconnect' else connection_health end,
        activated_at = case when ${running} then null else activated_at end,
        grant_generation = grant_generation + case when ${state} = 'disabled' and state <> 'disabled' then 1 else 0 end,
        updated_at = now()
        where id = ${id} returning *`;
      if (!updated) throw notFound('extension installation');
      if (ready)
        await this.queue().enqueueLifecycle(tx, caller.workspaceId, id, 'install', current.version);
      return present(updated);
    });
  }

  async enable(caller: Caller, id: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      const [current] = await tx<Row[]>`select * from extension_installations where id=${id}`;
      if (!current) throw notFound('extension installation');
      if (['active', 'installing', 'upgrading'].includes(current.state)) return present(current);
      if (['configuring', 'uninstalled', 'uninstalling'].includes(current.state))
        throw conflict('installation_disabled', 'finish setup or reinstall before enabling');
      const standalone =
        this.catalog.get(current.registration_id, current.version).manifest.execution ===
        'standalone';
      if (!standalone && !this.activation.has(current.release_digest))
        throw conflict(
          'incompatible_runtime',
          'no reviewed executable is deployed for this release',
        );
      const plan = await this.plan(tx, caller, {
        installationId: id,
        registrationId: current.registration_id,
        version: current.version,
        settings: current.settings,
      });
      if (plan.operations.length)
        throw conflict(
          'schema_binding_conflict',
          'retained schema bindings must be repaired with a validated upgrade',
        );
      await cancelRuns(tx, id, current.generation + 1);
      const [row] = await tx<
        Row[]
      >`update extension_installations set state=${standalone ? 'active' : 'installing'},setup_kind='install',generation=generation+1,
        connection_health=${standalone ? 'ok' : 'needs_reconnect'},last_error=null,activated_at=case when ${standalone} then clock_timestamp() else null end,updated_at=now() where id=${id} returning *`;
      if (!row) throw notFound('extension installation');
      if (!standalone)
        await this.queue().enqueueLifecycle(tx, caller.workspaceId, id, 'install', current.version);
      return present(row);
    });
  }

  async transition(caller: Caller, id: string, state: 'disabled' | 'uninstalled') {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      const [candidate] = await tx<Row[]>`select * from extension_installations where id = ${id}`;
      if (!candidate) throw notFound('extension installation');
      await lockInstallation(tx, caller.workspaceId, candidate.registration_id);
      // Re-read after acquiring the lock: another transition may have committed
      // since the routing lookup. Disable must never reverse an uninstall.
      const [current] = await tx<Row[]>`select * from extension_installations where id = ${id}`;
      if (!current) throw notFound('extension installation');
      if (['uninstalled', 'uninstalling'].includes(current.state)) return present(current);
      const resolution =
        state === 'uninstalled' ? resolveRelease(this.catalog.runtime, current) : undefined;
      if (current.state === 'configuring' && state !== 'uninstalled')
        throw conflict('installation_disabled', 'cancel or finish setup');
      const nextState =
        current.state !== 'configuring' &&
        resolution?.available &&
        resolution.manifest.execution === 'hosted' &&
        this.activation.has(current.release_digest)
          ? 'uninstalling'
          : state;
      const nextGeneration =
        current.generation + (current.state === nextState && current.last_error === null ? 0 : 1);
      await cancelRuns(tx, id, nextGeneration);
      // Repeating a disable keeps the grant: every path that disables a standalone
      // installation already advanced it, and paths that disable without doing so
      // (hosted setup failures) have no standalone credentials to revoke.
      const [row] = await tx<
        Row[]
      >`update extension_installations set state = ${nextState},last_error=null,
        cleanup_deadline=case when ${nextState}='uninstalling' then clock_timestamp()+interval '24 hours' else null end,
        generation = generation + case when state = ${nextState} and last_error is null then 0 else 1 end,
        grant_generation = grant_generation + case when state = ${nextState} then 0 else 1 end, updated_at = now()
        where id = ${id} returning *`;
      if (!row) throw notFound('extension installation');
      if (state === 'uninstalled') {
        const connections =
          await tx`select id from extension_connections where installation_id=${id} and state<>'disconnected' order by id`;
        for (const c of connections) await disconnectConnection(tx, caller.workspaceId, c.id);
        await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${id} and state<>'retired'`;
        await tx`select retainer_retire_extension_secrets(${id}::uuid)`;
      }
      await tx`delete from extension_suggestions where installation_id=${id}`;
      await tx`delete from extension_access_approvals where installation_id=${id}`;
      if (current.state === 'configuring') {
        await tx`delete from extension_kv where installation_id=${id}`;
        await tx`delete from extension_jobs where installation_id=${id}`;
        await tx`select retainer_finish_extension_cleanup(${id}::uuid)`;
      }
      if (nextState === 'uninstalling')
        await this.queue().enqueueLifecycle(tx, caller.workspaceId, id, 'uninstall');
      else if (nextState === 'uninstalled') {
        if (await failDisconnectCleanup(tx, id, 'cleanup_unavailable')) {
          row.last_error = 'cleanup_unavailable';
          await tx`update extension_installations set last_error='cleanup_unavailable' where id=${id}`;
        }
      }
      return present(row);
    });
  }
}

async function saveContribution(
  tx: Tx,
  workspaceId: string,
  installationId: string,
  kind: string,
  universalId: string,
  elementId: string,
  definition: unknown,
) {
  await tx`insert into extension_contributions (workspace_id, installation_id, kind, universal_id, element_id, definition)
    values (${workspaceId}, ${installationId}, ${kind}, ${universalId}, ${elementId}, ${tx.json(jsonValue(definition))})
    on conflict (workspace_id, kind, universal_id) do update set definition = excluded.definition
      where extension_contributions.installation_id = excluded.installation_id`;
}

/** Fields a reviewed mapping created become this installation's contributions. */
async function saveMappingContributions(
  tx: Tx,
  workspaceId: string,
  installationId: string,
  schema: Awaited<ReturnType<typeof loadSchemaState>>,
  mapped: ReturnType<typeof resolveMapping>,
) {
  for (const created of mapped.contributions) {
    const field = schema.objects
      .flatMap((o) => o.fields)
      .find((f) => f.universalId === created.universalId);
    if (!field?.id) throw conflict('schema_binding_conflict', 'mapped field missing after apply');
    await saveContribution(
      tx,
      workspaceId,
      installationId,
      'field',
      created.universalId,
      field.id,
      created.definition,
    );
  }
}
