import type {
  ExtensionInstallation,
  ExtensionInstallInput,
  ExtensionPreview,
} from '@retainer/extension';
import { HIDDEN_TYPE_IDS } from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import {
  inWorkspace,
  jsonValue,
  lockSchemaExclusive,
  lockSchemaShared,
  type Tx,
} from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { loadSchemaState } from '../schema/load.js';
import { planSchemaChange, runSchemaChange } from '../schema-engine/engine.js';
import { type SchemaOperation, schemaOperationSchema } from '../schema-engine/operations.js';
import { createViewInTransaction } from '../views/service.js';
import { ExtensionCatalog, hash } from './catalog.js';

export const installInputSchema = z.strictObject({
  registrationId: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()])),
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

type Row = {
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  state: ExtensionInstallation['state'];
  generation: number;
  settings_revision: number;
  settings: ExtensionInstallation['settings'];
  granted_actor: ExtensionInstallation['grantedActor'];
  granted_scopes: ExtensionInstallation['grantedScopes'];
  created_by: ExtensionInstallation['createdBy'];
};
function present(r: Row): ExtensionInstallation {
  return {
    id: r.id,
    registrationId: r.registration_id,
    version: r.version,
    releaseDigest: r.release_digest,
    state: r.state,
    generation: r.generation,
    settingsRevision: r.settings_revision,
    settings: r.settings,
    grantedActor: r.granted_actor,
    grantedScopes: r.granted_scopes,
    createdBy: r.created_by,
  };
}
async function lockInstallation(tx: Tx, workspace: string, registration: string) {
  await tx`select pg_advisory_xact_lock(21061::int4, hashtext(${`${workspace}:${registration}`}))`;
}

export class Extensions {
  constructor(
    private readonly sql: Sql,
    readonly catalog = new ExtensionCatalog(),
  ) {}

  async list(caller: Caller) {
    scope(caller, 'read');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => ({
      installations: (
        await tx<Row[]>`select * from extension_installations order by created_at, id`
      ).map(present),
    }));
  }
  async get(caller: Caller, id: string) {
    scope(caller, 'read');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const [row] = await tx<Row[]>`select * from extension_installations where id = ${id}`;
      if (!row) throw notFound('extension installation');
      const contributions =
        await tx`select kind, universal_id as "universalId", element_id as "elementId"
        from extension_contributions where installation_id = ${id} order by kind, universal_id`;
      return { ...present(row), contributions };
    });
  }

  private async plan(tx: Tx, caller: Caller, input: ExtensionInstallInput) {
    const release = this.catalog.get(input.registrationId, input.version);
    const manifest = release.manifest;
    if (Buffer.byteLength(JSON.stringify(input.settings)) > 65536)
      throw new AppError(413, 'quota_exceeded', 'settings exceed 64 KiB');
    for (const [key, value] of Object.entries(input.settings)) {
      const definition = manifest.settings[key];
      if (!definition || definition.secret || typeof value !== definition.type)
        throw new AppError(
          422,
          'invalid_settings',
          'unknown, secret or incorrectly typed setting',
          { key },
        );
    }
    for (const [key, definition] of Object.entries(manifest.settings)) {
      if (definition.secret)
        throw conflict('connection_required', 'secret broker support is required for this release');
      if (definition.required && input.settings[key] === undefined)
        throw new AppError(422, 'invalid_settings', 'required setting missing', { key });
    }
    const [workspace] = await tx<
      { schema_version: number }[]
    >`select schema_version from workspaces where id = ${caller.workspaceId}`;
    if (!workspace) throw notFound('workspace');
    const [existing] = await tx<
      Row[]
    >`select * from extension_installations where registration_id = ${input.registrationId}`;
    if (existing && existing.state !== 'uninstalled')
      throw conflict('upgrade_conflict', 'installation exists; use a validated upgrade');
    if (existing && existing.release_digest !== release.digest)
      throw conflict(
        'upgrade_conflict',
        'reinstall requires the retained release; upgrades are not yet supported',
      );
    const current = await loadSchemaState(tx, caller.workspaceId);
    const operations: SchemaOperation[] = [];
    const owned = existing
      ? await tx<{ kind: string; universal_id: string }[]>`
      select kind, universal_id from extension_contributions where installation_id = ${existing.id}`
      : [];
    const owns = (kind: string, id: string) =>
      owned.some((o) => o.kind === kind && o.universal_id === id);
    const targets = [
      ...manifest.schema.map((c) => (c.kind === 'object' ? c.definition.universalId : c.objectId)),
      ...manifest.views.map((v) => v.objectId),
      ...manifest.functions.flatMap((f) =>
        f.trigger.kind === 'change' ? [f.trigger.objectId] : [],
      ),
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
    for (const contribution of manifest.schema) {
      const id = contribution.definition.universalId;
      const found =
        contribution.kind === 'object'
          ? current.objects.find((o) => o.universalId === id)
          : current.objects.flatMap((o) => o.fields).find((f) => f.universalId === id);
      if (found) {
        if (!owns(contribution.kind, id))
          throw conflict(
            'schema_binding_conflict',
            `schema identity ${id} belongs to another source`,
          );
        // Reinstallation preserves all workspace customizations, including deprecation.
        continue;
      }
      if (owns(contribution.kind, id))
        throw conflict('schema_binding_conflict', `retained schema identity ${id} was removed`);
      operations.push(
        schemaOperationSchema.parse(
          contribution.kind === 'object'
            ? { op: 'create_object', object: contribution.definition }
            : { op: 'create_field', object: contribution.objectId, field: contribution.definition },
        ),
      );
    }
    const planned = planSchemaChange(current, operations, 'workspace');
    for (const view of manifest.views) {
      const [manager] = await tx<
        { installation_id: string }[]
      >`select installation_id from extension_contributions
        where kind = 'view' and universal_id = ${view.universalId}`;
      if (manager && manager.installation_id !== existing?.id)
        throw conflict(
          'schema_binding_conflict',
          `view ${view.universalId} belongs to another installation`,
        );
      if (owns('view', view.universalId)) continue;
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
        !object ||
        trigger.fieldIds.some((id) => !object.fields.some((f) => f.universalId === id))
      )
        throw conflict(
          'schema_binding_conflict',
          `function ${fn.universalId} has unresolved schema identities`,
        );
    }
    const generation = existing?.generation ?? 0;
    const preview: ExtensionPreview = {
      planDigest: hash({
        workspace: caller.workspaceId,
        schema: workspace.schema_version,
        generation,
        release: release.digest,
        settings: input.settings,
        settingsRevision: existing?.settings_revision ?? 0,
      }),
      schemaVersion: workspace.schema_version,
      generation,
      releaseDigest: release.digest,
      operations: planned.ops,
      views: manifest.views.map((view) => ({
        universalId: view.universalId,
        name: view.name,
        action: owns('view', view.universalId) ? 'retain' : 'create',
      })),
      grants: { actor: manifest.requestedActor, scopes: manifest.scopes },
      warnings: [
        'Runtime activation is unavailable. This installation remains disabled and cannot ingest data.',
      ],
    };
    return { preview, release, operations, existing };
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
      const manifest = plan.release.manifest;
      const [row] = await tx<Row[]>`insert into extension_installations
        (workspace_id, registration_id, version, release_digest, granted_actor, granted_scopes, settings, created_by)
        values (${caller.workspaceId}, ${manifest.universalId}, ${manifest.version}, ${plan.release.digest},
          ${manifest.requestedActor}, ${tx.json(manifest.scopes)}, ${tx.json(input.settings)}, ${tx.json(caller.actor)})
        on conflict (workspace_id, registration_id) do update set state = 'disabled',
          generation = extension_installations.generation + 1, settings = excluded.settings,
          settings_revision = extension_installations.settings_revision + 1, updated_at = now()
        returning *`;
      if (!row) throw new Error('installation insert returned no row');
      const schema = await loadSchemaState(tx, caller.workspaceId);
      const save = async (
        kind: string,
        universalId: string,
        elementId: string,
        definition: unknown,
      ) => {
        await tx`insert into extension_contributions (workspace_id, installation_id, kind, universal_id, element_id, definition)
          values (${caller.workspaceId}, ${row.id}, ${kind}, ${universalId}, ${elementId}, ${tx.json(jsonValue(definition))})
          on conflict (workspace_id, kind, universal_id) do nothing`;
      };
      for (const c of manifest.schema) {
        const element =
          c.kind === 'object'
            ? schema.objects.find((o) => o.universalId === c.definition.universalId)
            : schema.objects
                .flatMap((o) => o.fields)
                .find((f) => f.universalId === c.definition.universalId);
        if (!element?.id)
          throw conflict('schema_binding_conflict', 'contribution missing after apply');
        await save(c.kind, c.definition.universalId, element.id, c.definition);
        if (c.kind === 'object') {
          const object = schema.objects.find((o) => o.id === element.id);
          for (const f of c.definition.fields) {
            const field = object?.fields.find((v) => v.universalId === f.universalId);
            if (!field?.id) throw conflict('schema_binding_conflict', 'contributed field missing');
            await save('field', f.universalId, field.id, f);
          }
        }
      }
      for (const view of manifest.views) {
        const [retained] =
          await tx`select id from extension_contributions where kind = 'view' and universal_id = ${view.universalId}`;
        if (retained && !plan.existing)
          throw conflict('schema_binding_conflict', 'view identity already managed');
        if (retained) continue;
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
      const response = present(row);
      await tx`insert into extension_receipts (workspace_id, key, request_hash, installation_id, generation, response)
        values (${caller.workspaceId}, ${key}, ${requestHash}, ${row.id}, ${row.generation}, ${tx.json(jsonValue(response))})`;
      return response;
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
      if (current.state === 'uninstalled' && state === 'disabled') return present(current);
      const [row] = await tx<Row[]>`update extension_installations set state = ${state},
        generation = generation + case when state = ${state} then 0 else 1 end, updated_at = now()
        where id = ${id} returning *`;
      if (!row) throw notFound('extension installation');
      return present(row);
    });
  }
}
