import { randomUUID } from 'node:crypto';
import type { ExtensionManifest } from '@retainer/extension';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import {
  inWorkspace,
  lockForWrite,
  lockMemberShared,
  lockSchemaShared,
  type Tx,
} from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { disconnectConnection } from '../extension-runtime/connections.js';
import { lockExtension, lockQueue } from '../extension-runtime/locks.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import type { SecretBroker } from '../extension-runtime/secrets.js';
import { recheckPerson } from '../memory/profiles.js';
import type { ExtensionCatalog } from './catalog.js';

export const connectionInputSchema = z.strictObject({
  settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()])),
  secretRefs: z.record(z.string(), z.uuid()).default({}),
  expectedGeneration: z.number().int().positive().optional(),
});
type Input = z.infer<typeof connectionInputSchema>;

export function validateConnectionSettings(
  manifest: Pick<ExtensionManifest, 'settings'>,
  settings: Input['settings'],
) {
  if (Buffer.byteLength(JSON.stringify(settings)) > 65536)
    throw new AppError(413, 'quota_exceeded', 'connection settings exceed 64 KiB');
  for (const [key, value] of Object.entries(settings)) {
    const definition = manifest.settings[key];
    if (
      definition?.level !== 'connection' ||
      definition.secret ||
      typeof value !== definition.type ||
      (definition.options && !definition.options.includes(String(value)))
    )
      throw new AppError(
        422,
        'invalid_settings',
        'unknown, installation-level, secret or incorrectly typed connection setting',
        { key },
      );
  }
  for (const [key, definition] of Object.entries(manifest.settings))
    if (
      definition.level === 'connection' &&
      !definition.secret &&
      definition.required &&
      !Object.hasOwn(settings, key)
    )
      throw new AppError(422, 'invalid_settings', 'required connection setting missing', { key });
}
const ownerId = (caller: Caller) =>
  caller.person?.id ?? (caller.actor.type === 'user' ? caller.actor.id : null);
function human(caller: Caller) {
  if (caller.actor.type !== 'user' || caller.run || caller.installation)
    throw forbidden('only a person can manage a member connection');
}
async function membership(tx: Tx, caller: Caller) {
  if (caller.person) {
    await lockMemberShared(tx, caller.workspaceId, caller.person.id);
    await recheckPerson(tx, caller.workspaceId, caller.person);
  }
}

/** Human-owned credentials beneath an admin-approved installation. No owner is accepted in a payload. */
export class MemberConnections {
  constructor(
    private readonly sql: Sql,
    private readonly catalog: ExtensionCatalog,
    private readonly broker?: SecretBroker,
  ) {}
  private async installation(tx: Tx, caller: Caller, id: string, active = true) {
    const [candidate] = await tx`select * from extension_installations where id=${id}`;
    if (!candidate) throw notFound('extension installation');
    await lockExtension(tx, caller.workspaceId, candidate.registration_id);
    await lockQueue(tx, caller.workspaceId, id);
    const [current] =
      await tx`select i.* from extension_installations i join workspaces w on w.id=i.workspace_id
      where i.id=${id} and w.deletion_scheduled_at is null`;
    if (!current) throw notFound('extension installation');
    if (active && current.state !== 'active')
      throw new AppError(409, 'installation_disabled', 'connect only to an active installation');
    return current;
  }
  async stage(
    caller: Caller,
    id: string,
    input: { connectionId?: string; name: string; value: string },
  ) {
    human(caller);
    const scope = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      const i = await this.installation(tx, caller, id);
      const manifest = this.catalog.get(i.registration_id, i.version).manifest;
      const definition = manifest.settings[input.name];
      if (
        manifest.connection !== 'member' ||
        definition?.level !== 'connection' ||
        !definition.secret ||
        definition.generated
      )
        throw new AppError(422, 'invalid_secret', 'setting is not a declared member credential');
      if (input.connectionId) {
        const [c] =
          await tx`select owner_id,state from extension_connections where id=${input.connectionId} and installation_id=${id}`;
        if (c && (c.owner_id !== caller.actor.id || c.state === 'disconnected'))
          throw notFound('connection');
      }
      return {
        registrationId: manifest.universalId,
        installationId: id,
        connectionId: input.connectionId ?? randomUUID(),
      };
    });
    if (!this.broker)
      throw new AppError(503, 'connection_required', 'secret broker is not configured');
    return this.broker.stage(caller, { ...scope, name: input.name, value: input.value });
  }
  async connect(caller: Caller, id: string, input: Input, reconnect?: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      const i = await this.installation(tx, caller, id);
      const manifest = this.catalog.get(i.registration_id, i.version).manifest;
      if (manifest.connection !== 'member')
        throw new AppError(
          422,
          'invalid_connection',
          'this installation connects at workspace level',
        );
      validateConnectionSettings(manifest, input.settings);
      const refs = Object.values(input.secretRefs);
      const pending = refs.length
        ? await tx`select * from retainer_member_pending_secrets(${refs}::uuid[],${caller.actor.id})`
        : [];
      if (pending.length !== refs.length)
        throw new AppError(
          409,
          'connection_required',
          'a member secret reference is invalid or expired',
        );
      const cid = reconnect ?? pending[0]?.connection_id ?? randomUUID();
      const [prior] =
        await tx`select * from extension_connections where id=${cid} and installation_id=${id}`;
      if (
        reconnect &&
        (!prior || prior.owner_id !== caller.actor.id || prior.state === 'disconnected')
      )
        throw notFound('connection');
      if (reconnect && input.expectedGeneration !== prior?.generation)
        throw new AppError(409, 'stale_plan', 'connection generation changed');
      if (
        !reconnect &&
        (await tx`select 1 from extension_connections where installation_id=${id} and owner_id=${caller.actor.id} and state<>'disconnected'`.then(
          (rows) => rows.length > 0,
        ))
      )
        throw new AppError(
          409,
          'connection_exists',
          'you already have a connection; reconnect or disconnect it',
        );
      for (const [name, ref] of Object.entries(input.secretRefs)) {
        const definition = manifest.settings[name];
        const row = pending.find((p) => p.id === ref);
        if (
          !definition?.secret ||
          definition.generated ||
          definition.level !== 'connection' ||
          !row ||
          row.name !== name ||
          row.connection_id !== cid ||
          row.draft_installation_id !== id ||
          row.registration_id !== manifest.universalId
        )
          throw new AppError(
            422,
            'invalid_secret',
            'secret reference belongs to another connection or setting',
            { key: name },
          );
      }
      const [stored] = reconnect
        ? await tx`select retainer_connection_secret_names(${id}::uuid,${cid}::uuid) as names`
        : [];
      for (const [name, definition] of Object.entries(manifest.settings))
        if (
          definition.level === 'connection' &&
          definition.secret &&
          definition.required &&
          !input.secretRefs[name] &&
          !stored?.names.includes(name)
        )
          throw new AppError(422, 'invalid_secret', 'required connection secret missing', {
            key: name,
          });
      const disconnect =
        manifest.functions.find((f) => f.trigger.kind === 'disconnect')?.universalId ?? null;
      if (reconnect) {
        await tx`update extension_attempts set status='cancelled',code='connection_reconnected',finished_at=clock_timestamp()
          where finished_at is null and job_id in(select id from extension_jobs where connection_id=${cid})`;
        await tx`update extension_jobs set status='cancelled',code='connection_reconnected',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
          where connection_id=${cid} and status in ('queued','running')`;
        await tx`delete from extension_schedules where connection_id=${cid}`;
        await tx`delete from source_sync_state where connection_id=${cid}`;
        await tx`update extension_connections set state='connecting',health='ok',last_error=null,generation=generation+1,settings_revision=settings_revision+1,
          owner=${tx.json(caller.actor)},settings=${tx.json(input.settings)},disconnect_function_id=${disconnect} where id=${cid}`;
      } else {
        await tx`insert into extension_connections(id,workspace_id,installation_id,owner,owner_id,settings,disconnect_function_id)
          values(${cid},${caller.workspaceId},${id},${tx.json(caller.actor)},${caller.actor.id},${tx.json(input.settings)},${disconnect})`;
      }
      for (const [name, ref] of Object.entries(input.secretRefs)) {
        const [adopted] =
          await tx`select retainer_adopt_member_secret(${ref}::uuid,${id}::uuid,${manifest.universalId}::uuid,${cid}::uuid,${caller.actor.id},${name}) as ok`;
        if (!adopted?.ok)
          throw new AppError(409, 'connection_required', 'member secret could not be adopted');
      }
      await new ExtensionQueue(this.sql, this.catalog.runtime).enqueueConnectionLifecycle(
        tx,
        caller.workspaceId,
        id,
        cid,
        reconnect ? i.version : null,
      );
      return { id: cid, state: 'connecting' };
    });
  }
  async disconnect(caller: Caller, id: string, cid: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      await this.installation(tx, caller, id, false);
      const [c] =
        await tx`select owner_id from extension_connections where id=${cid} and installation_id=${id}`;
      if (
        !c ||
        (c.owner_id !== caller.actor.id && !canApproveDestructive(caller.actor, caller.scopes))
      )
        throw notFound('connection');
      await disconnectConnection(tx, caller.workspaceId, cid);
      return { disconnected: true };
    });
  }
  async list(caller: Caller, id: string) {
    if (caller.run || caller.installation)
      throw forbidden('runtime credentials cannot list member connections');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await membership(tx, caller);
      const [i] = await tx`select id from extension_installations where id=${id}`;
      if (!i) throw notFound('extension installation');
      const all = canApproveDestructive(caller.actor, caller.scopes);
      const rows =
        await tx`select c.*,retainer_connection_secret_names(c.installation_id,c.id) as secret_names,
        s.last_successful_scan_at,
        (select count(*)::int from extension_jobs j where j.connection_id=c.id and j.connection_generation=c.generation and j.generation=i.generation and j.source_item_id is not null and j.status='failed') as failed_items
        from extension_connections c join extension_installations i on i.id=c.installation_id left join source_sync_state s on s.connection_id=c.id and s.installation_id=c.installation_id
        where c.installation_id=${id} ${all ? tx`` : tx`and c.owner_id=${ownerId(caller)}`} order by c.created_at,c.id`;
      return {
        connections: rows.map((c) => ({
          id: c.id,
          installationId: c.installation_id,
          owner: c.owner,
          state: c.state,
          health: c.health,
          lastError: c.last_error,
          generation: c.generation,
          settings: c.settings,
          settingsRevision: c.settings_revision,
          secrets: c.secret_names,
          createdAt: c.created_at.toISOString(),
          connectedAt: c.connected_at?.toISOString() ?? null,
          disconnectedAt: c.disconnected_at?.toISOString() ?? null,
          lastSuccessfulScanAt: c.last_successful_scan_at?.toISOString() ?? null,
          failedItems: c.failed_items,
        })),
      };
    });
  }
}
