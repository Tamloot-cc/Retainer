import { type ExtensionManifest, sourceDeletePolicy } from '@retainer/extension';
import {
  type SourceScan,
  type SourceSyncStatus,
  sourceScanSchema,
  type ValueField,
} from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockForWrite, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller, admitRun } from '../extension-runtime/admission.js';
import {
  createsRecords,
  requireBindingCreation,
  type StoredBindingPlan,
} from '../extension-runtime/bindings.js';
import { cancelRuns, lockExtension } from '../extension-runtime/locks.js';
import { requestHash } from '../idempotency.js';
import { storeEventBody } from '../memory/event-bodies.js';
import { logEvent, retractEventClaims } from '../memory/events.js';
import { isEventIdentitySuppressed, isSuppressed, suppressedOf } from '../privacy/suppression.js';
import { withRead, withWrite } from '../records/service.js';
import { normalizeFieldValue, prepareValues } from '../records/values.js';
import {
  insertRecord,
  lockRecordsForUpdate,
  markDeleted,
  refuseOwnedRecordChange,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import { getSchema } from '../schema/compiled.js';
import {
  prepareSourceSchema,
  reserveSourceBatchSchema,
  reserveSourceSchema,
  type SourceEventInput,
  type SourceResult,
  sourceBindingSchema,
  sourceEventSchema,
  sourceTaskBatchSchema,
  sourceUnavailableSchema,
} from './contract.js';
import {
  compareRevision,
  resolveSourcePolicy,
  type SourcePolicy,
  sourceIdentityChannel,
} from './policy.js';
import { reserveSourceItem } from './reserve.js';
import { reconcileTasks, taskSchema } from './tasks.js';

type Resolve = (registration: string, version: string, digest: string) => ExtensionManifest;
type Binding = {
  account_id: string;
  namespace: string;
  provider: string;
  registration_id: string;
  version: string;
  release_digest: string;
};
type Item = {
  task_write_revision?: number;
  id: string;
  account_id: string;
  external_id: string | null;
  state: string;
  provider_revision: string | null;
};
type Revision = { id: string; event_id: string; content_digest: string };
type SourceProjection = {
  binding: string;
  /** Existing receipts keep the canonical format accepted before binding plans. */
  canonicalType?: string;
  includeContent?: boolean;
  fields: Record<
    string,
    { field: ValueField; values: Record<string, string>; canonicalKey?: string }
  >;
};
type SourceReceipt = {
  content_digest: string;
  response: SourceResult;
  projection: SourceProjection | null;
};
const conflict = (code: string, message: string) => new AppError(409, code, message);
const emptyInvalidation = () => ({
  retractedAssertions: 0,
  recomputedRecordIds: [] as string[],
  hiddenFactIds: [] as string[],
});

/** Provider I/O runs in pinned isolated functions; this service validates their scoped attestations. */
export class Sources {
  constructor(
    private readonly sql: Sql,
    private readonly resolve: Resolve,
  ) {}
  private runtime(caller: Caller, id: string) {
    if (!caller.run || caller.run.installationId !== id) throw notFound('installation source');
    if (!caller.scopes.includes('write')) throw forbidden('source ingestion requires write scope');
    return caller.run;
  }
  private async release(tx: Tx, caller: Caller) {
    const run = caller.run;
    if (!run) throw forbidden('source operation requires an installation credential');
    const [i] = await tx<
      {
        version: string;
        release_digest: string;
        bindings: StoredBindingPlan | null;
      }[]
    >`select version,release_digest,bindings from extension_installations where id=${run.installationId}`;
    if (!i) throw notFound('installation source');
    const manifest = this.resolve(run.registrationId, i.version, i.release_digest);
    if (!manifest.source) throw forbidden('release has no managed source capability');
    return {
      manifest,
      policy: resolveSourcePolicy(manifest.source, i.bindings ?? undefined),
    };
  }
  private async binding(tx: Tx, caller: Caller): Promise<Binding> {
    const run = caller.run;
    if (!run) throw forbidden('source operation requires an installation credential');
    const [binding] = await tx<
      Binding[]
    >`select b.account_id,a.namespace,a.provider,a.registration_id,i.version,i.release_digest
      from source_bindings b join source_accounts a on a.id=b.account_id join extension_installations i on i.id=b.installation_id
      where b.installation_id=${run.installationId} and b.connection_id is not distinct from ${run.connectionId ?? null}::uuid and b.generation=${run.generation} and a.registration_id=${run.registrationId}`;
    if (!binding)
      throw conflict(
        'source_connection_required',
        'the source connection has not been verified for this generation',
      );
    return binding;
  }
  /** Only the pinned setup verifier may bind a provider identity, after explicit workspace-sharing approval. */
  async verify(caller: Caller, id: string, raw: z.input<typeof sourceBindingSchema>) {
    const run = this.runtime(caller, id),
      input = sourceBindingSchema.parse(raw);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller);
      const [job] =
        await tx`select function_id,trigger_kind from extension_jobs where id=${run.jobId}`;
      if (
        job?.trigger_kind !== (run.connectionId ? 'connect' : 'install') ||
        job.function_id !== policy.verifyFunctionId
      )
        throw forbidden('only the registered source verifier may attest a connection');
      if ((policy.identity === 'account') !== (input.accountId !== undefined))
        throw new AppError(
          422,
          'invalid_source_identity',
          'supply a provider account ID only for an account-scoped provider',
        );
      const identity =
        policy.identity === 'global-resource' ? 'global' : (input.accountId as string);
      const namespace = requestHash({ identity, strategy: policy.identity });
      const [prior] = run.connectionId
        ? await tx`select a.namespace,a.provider from extension_connections c join source_accounts a on a.id=c.source_account_id where c.id=${run.connectionId} and c.installation_id=${id}`
        : await tx`select a.namespace,a.provider from source_bindings b join source_accounts a on a.id=b.account_id where b.installation_id=${id} and b.connection_id is null`;
      if (prior && (prior.namespace !== namespace || prior.provider !== policy.provider))
        throw conflict(
          'source_account_changed',
          'disconnect the retained source connection before replacing its account',
        );
      const [account] = await tx<
        { id: string }[]
      >`insert into source_accounts(workspace_id,registration_id,provider,namespace,identity)
        values(${caller.workspaceId},${run.registrationId},${policy.provider},${namespace},${identity})
        on conflict(workspace_id,registration_id,provider,namespace) do update set namespace=excluded.namespace returning id`;
      if (!account) throw new Error('source account insert returned no row');
      if (run.connectionId) {
        const [other] =
          await tx`select 1 from source_bindings where installation_id=${id} and account_id=${account.id} and connection_id<>${run.connectionId}`;
        if (other)
          throw conflict(
            'source_account_in_use',
            'this source account is already connected in this workspace',
          );
      }
      await tx`insert into source_bindings(workspace_id,installation_id,connection_id,account_id,generation)
        values(${caller.workspaceId},${id},${run.connectionId ?? null},${account.id},${run.generation})
        on conflict(workspace_id,installation_id,connection_id) do update set account_id=excluded.account_id,generation=excluded.generation,verified_at=clock_timestamp()`;
      if (run.connectionId)
        await tx`update extension_connections set source_account_id=${account.id} where id=${run.connectionId}`;
      return {
        sourceAccountId: account.id,
        provider: policy.provider,
        identity: policy.identity,
        sharing: input.sharing,
      };
    });
  }
  async disconnect(caller: Caller, id: string) {
    if (!canApproveDestructive(caller.actor, caller.scopes) || caller.run)
      throw forbidden('only a human admin may disconnect a source');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      const [i] = await tx`select registration_id from extension_installations where id=${id}`;
      if (!i) throw notFound('installation source');
      await lockExtension(tx, caller.workspaceId, i.registration_id);
      const [current] = await tx`select generation from extension_installations where id=${id}`;
      if (!current) throw notFound('installation source');
      await cancelRuns(tx, id, current.generation + 1);
      await tx`delete from source_bindings where installation_id=${id}`;
      await tx`delete from source_sync_state where installation_id=${id}`;
      await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${id} and state<>'retired'`;
      await tx`update extension_installations set state='disabled',generation=generation+1,grant_generation=grant_generation+1,connection_health='needs_reconnect',last_error=null where id=${id}`;
      return { disconnected: true };
    });
  }
  private async usable(tx: Tx, caller: Caller, binding: Binding, item: Item) {
    if (item.account_id !== binding.account_id) throw notFound('source item');
    if (
      item.state === 'erased' ||
      !item.external_id ||
      (await isEventIdentitySuppressed(
        tx,
        caller.workspaceId,
        sourceIdentityChannel(binding.registration_id, binding.provider, binding.namespace),
        item.external_id,
      ))
    )
      throw conflict(
        'source_erased',
        'this source identity was erased and cannot be imported again',
      );
  }
  async connection(caller: Caller, id: string) {
    const run = this.runtime(caller, id);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller),
        binding = await this.binding(tx, caller);
      return {
        sourceAccountId: binding.account_id,
        provider: binding.provider,
        identity: policy.identity,
      };
    });
  }
  /** Recovery enumerates local identities, never provider payloads, in the admitted account only. */
  async items(caller: Caller, id: string, limit = 30, cursor?: string) {
    const run = this.runtime(caller, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError(400, 'invalid_request', 'limit must be between 1 and 100');
    if (cursor) z.uuid().parse(cursor);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller),
        binding = await this.binding(tx, caller);
      if (
        run.functionId !== policy.verifyFunctionId &&
        !policy.scanFunctionIds?.includes(run.functionId)
      )
        throw forbidden('only registered source scan functions may enumerate recovery items');
      const rows = await tx<
        { id: string }[]
      >`select id from source_items where account_id=${binding.account_id}
        and (state in ('reserved','live','unavailable') ${policy.tasks ? tx`or (state in ('deleted','retracted') and exists(select 1 from source_tasks t where t.item_id=source_items.id and t.state='synced'))` : tx``}) ${cursor ? tx`and id>${cursor}::uuid` : tx``} order by id limit ${limit + 1}`;
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => ({ sourceItemId: row.id })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }
  async beginScan(caller: Caller, id: string, raw: SourceScan) {
    const run = this.runtime(caller, id),
      input = sourceScanSchema.parse(raw);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller);
      await this.binding(tx, caller);
      const [job] =
        await tx`select function_id,trigger_kind from extension_jobs where id=${run.jobId}`;
      if (
        !(
          (['install', 'connect'].includes(job?.trigger_kind) &&
            job?.function_id === policy.verifyFunctionId) ||
          (policy.scanFunctionIds ?? []).includes(job?.function_id)
        )
      )
        throw forbidden('only registered source scan functions may begin enumeration');
      const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
      if (
        !clock ||
        Date.parse(input.through) > clock.now.getTime() + 60000 ||
        Date.parse(input.through) - Date.parse(input.from) > 3660 * 86400000
      )
        throw new AppError(
          422,
          'invalid_scan',
          'source scan bounds exceed the allowed clock window',
        );
      // The unique installation row serializes competing starts, without taking a queue lock after admission.
      await tx`insert into source_sync_state(workspace_id,installation_id,connection_id,generation,scan_id,mode,lower_bound,upper_bound)
        values(${caller.workspaceId},${id},${run.connectionId ?? null},${run.generation},${input.scanId},${input.mode},${input.from},${input.through})
        on conflict(workspace_id,installation_id,connection_id) do nothing`;
      const [current] =
        await tx`select *,lower_bound=${input.from}::timestamptz and upper_bound=${input.through}::timestamptz as same_bounds
        from source_sync_state where installation_id=${id} and connection_id is not distinct from ${run.connectionId ?? null}::uuid for update`;
      if (!current) throw new Error('source scan missing');
      if (current.scan_id === input.scanId && (!current.same_bounds || current.mode !== input.mode))
        throw conflict('scan_conflict', 'scan identity was used for different bounds');
      if (
        current.scan_id !== input.scanId &&
        current.completed_at === null &&
        current.generation === run.generation
      )
        throw conflict('scan_conflict', 'an enumeration is already in progress');
      if (current.scan_id !== input.scanId)
        await tx`update source_sync_state set generation=${run.generation},scan_id=${input.scanId},mode=${input.mode},
          lower_bound=${input.from},upper_bound=${input.through},started_at=clock_timestamp(),completed_at=null where installation_id=${id} and connection_id is not distinct from ${run.connectionId ?? null}::uuid`;
      else if (current.generation !== run.generation)
        await tx`update source_sync_state set generation=${run.generation} where installation_id=${id} and connection_id is not distinct from ${run.connectionId ?? null}::uuid`;
      return { scanId: input.scanId };
    });
  }
  async syncStatus(caller: Caller, id: string, connectionId?: string): Promise<SourceSyncStatus> {
    if (caller.installation && caller.installation.installationId !== id)
      throw notFound('installation source');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      if (caller.run) {
        this.runtime(caller, id);
        await admitRun(tx, caller.workspaceId, caller.run, false, 'runtime');
      }
      if (caller.installation) await admitCaller(tx, caller);
      const [installation] =
        await tx`select registration_id,version,release_digest,generation from extension_installations where id=${id}`;
      if (
        !installation ||
        !this.resolve(
          installation.registration_id,
          installation.version,
          installation.release_digest,
        ).source
      )
        throw notFound('installation source');
      const manifest = this.resolve(
        installation.registration_id,
        installation.version,
        installation.release_digest,
      );
      let cid = caller.run?.connectionId ?? null;
      if (manifest.connection === 'member' && !caller.run) {
        const owner = caller.person?.id ?? (caller.actor.type === 'user' ? caller.actor.id : null);
        const [c] = await tx`select id from extension_connections where installation_id=${id}
          ${connectionId ? tx`and id=${connectionId}` : tx`and state<>'disconnected' and owner_id=${owner}`}
          ${canApproveDestructive(caller.actor, caller.scopes) ? tx`` : tx`and owner_id=${owner}`} order by created_at desc limit 1`;
        if (!c) throw notFound('member connection');
        cid = c.id;
      }
      const [state] =
        await tx`select * from source_sync_state where installation_id=${id} and connection_id is not distinct from ${cid}::uuid`;
      const [counts] = await tx<{ pending: number; failed: number }[]>`select
        count(*) filter(where status in ('queued','running'))::int as pending,
        count(*) filter(where status='failed')::int as failed
        from extension_jobs where installation_id=${id} and connection_id is not distinct from ${cid}::uuid and generation=${installation.generation} and source_item_id is not null and (${cid}::uuid is null or connection_generation=(select generation from extension_connections where id=${cid}))`;
      return {
        lastSuccessfulScanAt: state?.last_successful_scan_at?.toISOString() ?? null,
        activeScan:
          state && !state.completed_at
            ? {
                scanId: state.scan_id,
                mode: state.mode,
                from: state.lower_bound.toISOString(),
                through: state.upper_bound.toISOString(),
                generation: state.generation,
                startedAt: state.started_at.toISOString(),
              }
            : null,
        pendingItems: counts?.pending ?? 0,
        failedItems: counts?.failed ?? 0,
      };
    });
  }
  /** A provider page reserves only identities; its durable enqueue/checkpoint follows separately. */
  async reserveBatch(caller: Caller, id: string, raw: z.input<typeof reserveSourceBatchSchema>) {
    this.runtime(caller, id);
    const input = reserveSourceBatchSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller);
        if (binding.account_id !== input.sourceAccountId) throw notFound('source account');
        const results = new Map<
          string,
          | {
              externalId: string;
              sourceItemId: string;
              state: string;
              providerRevision: string | null;
            }
          | { externalId: string; code: 'source_erased' | 'source_deleted' }
        >();
        // Stable lock order lets overlapping page reservations compete without per-item deadlocks.
        for (const externalId of [...input.externalIds].sort()) {
          try {
            const item = await reserveSourceItem(tx, caller.workspaceId, binding, externalId);
            await this.usable(tx, caller, binding, item);
            results.set(
              externalId,
              ['retracted', 'deleted'].includes(item.state)
                ? { externalId, code: 'source_deleted' }
                : {
                    externalId,
                    sourceItemId: item.id,
                    state: item.state,
                    providerRevision: item.provider_revision,
                  },
            );
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'source_erased') throw error;
            results.set(externalId, { externalId, code: 'source_erased' });
          }
        }
        return {
          items: input.externalIds.map((externalId) => {
            const result = results.get(externalId);
            if (!result) throw new Error('source reservation result missing');
            return result;
          }),
        };
      },
      {},
      { asPerson: false },
    );
  }
  async reserve(caller: Caller, id: string, raw: z.input<typeof reserveSourceSchema>) {
    this.runtime(caller, id);
    const input = reserveSourceSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller);
        if (binding.account_id !== input.sourceAccountId) throw notFound('source account');
        const item = await reserveSourceItem(tx, caller.workspaceId, binding, input.externalId);
        await this.usable(tx, caller, binding, item);
        return { sourceItemId: item.id };
      },
      {},
      { asPerson: false },
    );
  }
  async get(caller: Caller, id: string, itemId: string) {
    this.runtime(caller, id);
    return withRead(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId}`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${itemId} and is_current`;
        return {
          sourceItemId: item.id,
          taskWriteRevision: item.task_write_revision ?? 0,
          sourceAccountId: item.account_id,
          externalId: item.external_id,
          state: item.state,
          providerRevision: item.provider_revision,
          revisionId: current?.id ?? null,
          eventId: current?.event_id ?? null,
          contentDigest: current?.content_digest ?? null,
        };
      },
      { privacy: true },
    );
  }
  private async ingestionJob(tx: Tx, caller: Caller, policy: SourcePolicy, itemId: string) {
    const [job] =
      await tx`select function_id,source_item_id from extension_jobs where id=${caller.run?.jobId ?? null}`;
    if (!policy.syncFunctionIds.includes(job?.function_id) || job?.source_item_id !== itemId)
      throw forbidden("only this item's registered ingestion job may change its evidence");
  }
  /** Stage ownership before bytes: an erasure can find uploads even before the first event revision. */
  async prepare(
    caller: Caller,
    id: string,
    itemId: string,
    raw: z.input<typeof prepareSourceSchema>,
  ) {
    const run = this.runtime(caller, id),
      input = prepareSourceSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller),
          { policy } = await this.release(tx, caller);
        if (policy.provider === 'gmail')
          throw forbidden('use the Gmail message eligibility check to prepare body retrieval');
        await this.ingestionJob(tx, caller, policy, itemId);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['retracted', 'deleted'].includes(item.state))
          throw conflict(
            'source_retracted',
            'deleted source identities cannot be silently recreated',
          );
        const handles = input.participants.map((value) => ({ kind: 'email' as const, value }));
        const suppressed = await suppressedOf(tx, caller.workspaceId, handles);
        // An erased participant is dropped, as core addLinks does; the meeting itself still imports.
        const kept = handles.filter((h) => !isSuppressed(suppressed, h)).map((h) => h.value);
        await tx`delete from source_participants where item_id=${itemId}`;
        for (const email of new Set(kept))
          await tx`insert into source_participants(workspace_id,item_id,email) values(${caller.workspaceId},${itemId},${email})`;
        await tx`update source_items set prepared_job_id=${run.jobId},prepared_fence=${run.fence}::bigint where id=${itemId}`;
        return { prepared: true };
      },
      {},
      { asPerson: false },
    );
  }
  async unavailable(
    caller: Caller,
    id: string,
    itemId: string,
    raw: z.input<typeof sourceUnavailableSchema>,
  ) {
    this.runtime(caller, id);
    const input = sourceUnavailableSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx, context) => {
        const binding = await this.binding(tx, caller),
          { policy, manifest } = await this.release(tx, caller);
        await this.ingestionJob(tx, caller, policy, itemId);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['deleted', 'retracted'].includes(item.state))
          return { state: item.state, invalidated: emptyInvalidation() };
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${itemId} and is_current`;
        let invalidated = emptyInvalidation();
        // The admin's choice, read only when a deletion arrives.
        const retract =
          input.status === 'deleted' &&
          sourceDeletePolicy(
            manifest,
            (
              await tx<{ settings: Record<string, unknown> }[]>`
                select settings from extension_installations where id=${id}`
            )[0]?.settings ?? {},
          ) === 'retract';
        if (retract && current) {
          const [event] = await lockRecordsForUpdate(tx, caller.workspaceId, [current.event_id]);
          if (event && !event.deleted_at)
            await refuseOwnedRecordChange(tx, context, [event], 'delete');
          await context.changes?.capture(tx, current.event_id, 'retract');
          await markDeleted(tx, context, [current.event_id]);
          invalidated = await retractEventClaims(tx, context, [current.event_id]);
        }
        const state = retract
          ? 'retracted'
          : input.status === 'deleted'
            ? 'deleted'
            : 'unavailable';
        await tx`update source_items set state=${state},updated_at=clock_timestamp() where id=${itemId}`;
        return { state, invalidated };
      },
      {},
      { asPerson: false },
    );
  }
  private async normalize(
    tx: Tx,
    context: WriteContext,
    policy: SourcePolicy,
    input: SourceEventInput,
    accepted?: SourceProjection,
  ) {
    const destination = policy.plan.destinations[policy.event];
    const binding = accepted?.binding ?? policy.event;
    if (input.event.binding !== binding)
      throw forbidden('Use the registered source event binding.');
    const object = context.schema.objectsByUniversalId.get(destination?.objects[0] ?? '');
    if (
      !accepted &&
      (!object || object.hidden || !object.isEvent || object.state.status !== 'active')
    )
      throw conflict('binding_unavailable', 'The approved event destination is unavailable.');
    const projection: SourceProjection = accepted ?? {
      binding,
      fields: Object.fromEntries(
        Object.entries(destination?.fields ?? {}).map(([key, target]) => {
          const field = object?.activeFields.find((entry) => entry.universalId === target.id);
          if (!field || field.coreRole || field.settings.isInverse)
            throw conflict(
              'binding_unavailable',
              `The approved event field ${key} is unavailable.`,
            );
          return [
            key,
            {
              field: { type: field.type, settings: field.settings, isNullable: field.isNullable },
              values: target.values,
            },
          ];
        }),
      ),
    };
    const fields: Record<string, unknown> = {},
      canonicalFields: Record<string, unknown> = {};
    const declared = policy.plan.declarations.find((entry) => entry.key === policy.event);
    for (const [key, value] of Object.entries(input.event.fields)) {
      const stored = projection.fields[key];
      const live = accepted
        ? undefined
        : object?.activeFields.find((field) => destination?.fields[key]?.id === field.universalId);
      if (!stored && declared?.fields.some((field) => field.key === key)) continue;
      if (!stored)
        throw new AppError(
          422,
          'invalid_source_field',
          'Use a field key from the approved event binding.',
          { key },
        );
      const field = stored.field;
      const mapped = stored.values;
      const isMapped = Object.keys(mapped).length > 0;
      if (isMapped && (typeof value !== 'string' || !Object.hasOwn(mapped, value)))
        throw new AppError(422, 'invalid_source_field', `Unknown source value for ${key}.`, {
          key,
        });
      const normalized = normalizeFieldValue(field, isMapped ? mapped[value as string] : value);
      if (live) fields[live.name] = normalized;
      const canonicalKey = stored.canonicalKey ?? key;
      if (field.type === 'files') {
        const ids = (normalized ?? []) as string[];
        const rows = ids.length
          ? await tx<
              { id: string; metadata: { sha256?: string } }[]
            >`select id,metadata from files where id=any(${ids}::uuid[]) and state='ready' and installation_id=${context.run?.installationId ?? null} and source_item_id=${input.sourceItemId}`
          : [];
        if (rows.length !== ids.length)
          throw new AppError(
            422,
            'invalid_files',
            'source files must be ready uploads bound to this source item',
          );
        canonicalFields[canonicalKey] =
          normalized === null
            ? null
            : ids.map((id) => {
                const metadata = rows.find((row) => row.id === id)?.metadata;
                return !projection.canonicalType ? (metadata?.sha256 ?? metadata) : metadata;
              });
      } else
        canonicalFields[canonicalKey] = isMapped && !projection.canonicalType ? value : normalized;
    }
    const listed = [...new Map(input.event.participants.map((p) => [p.email, p])).values()].sort(
      (a, b) => a.email.localeCompare(b.email),
    );
    const suppressed = await suppressedOf(
      tx,
      context.workspaceId,
      listed.map((p) => ({ kind: 'email' as const, value: p.email })),
    );
    // Erased participants are dropped before the digest, so no stored digest or row carries them.
    const participants = listed.filter(
      (p) => !isSuppressed(suppressed, { kind: 'email', value: p.email }),
    );
    const canonicalOf = (people: typeof listed) => ({
      type: projection.canonicalType ?? binding,
      occurredAt: new Date(input.event.occurredAt).toISOString(),
      title: input.event.title,
      summary: input.event.summary ?? '',
      // stableJson drops an undefined content, so events without one keep their digests.
      content: projection.includeContent === false ? undefined : input.event.content,
      fields: canonicalFields,
      participants: people,
      about: [...new Set(input.event.about)].sort(),
    });
    const canonical = canonicalOf(participants),
      digest = requestHash(canonical);
    // A client digest over the event as it sent it (erased handle included) is checked in memory only.
    const submittedDigest =
      participants.length === listed.length ? digest : requestHash(canonicalOf(listed));
    return { object, fields, participants, projection, digest, submittedDigest };
  }
  private async bindParticipants(
    tx: Tx,
    context: WriteContext,
    policy: SourcePolicy,
    participants: SourceEventInput['event']['participants'],
  ) {
    const declaration = policy.plan.declarations.find((entry) => entry.key === policy.people);
    const binding = declaration && policy.plan.destinations[declaration.key];
    if (!declaration || !binding || !declaration.match)
      return participants.map(({ email }) => ({ handle: email }));
    const object = context.schema.objectsByUniversalId.get(binding.objects[0] ?? '');
    const field = object?.activeFields.find(
      (f) => f.universalId === binding.fields[declaration.match ?? '']?.id,
    );
    if (!object || !field?.id)
      throw conflict('binding_unavailable', 'The approved contact matching field is unavailable.');
    const name = object.activeFields.find((f) => f.universalId === binding.fields.name?.id);
    const mode = policy.plan.createPeople ?? 'never';
    const output: { handle: string; recordId?: string }[] = [];
    for (const participant of participants) {
      const { email } = participant;
      const rows = await tx<{ record_id: string | null }[]>`
        select distinct canonical.id as record_id
        from record_identifiers i
        join records r on r.id = i.record_id and r.workspace_id = i.workspace_id
        left join records canonical on canonical.id = coalesce(r.merged_into_id, r.id)
          and canonical.workspace_id = i.workspace_id and canonical.object_type_id = ${object.id}
          and canonical.deleted_at is null and canonical.merged_into_id is null
          and canonical.private_to_user is null
        where i.workspace_id = ${context.workspaceId} and i.field_id = ${field.id}
          and i.kind = 'email' and i.value = ${email} and r.object_type_id = ${object.id}
        order by record_id nulls last limit 2`;
      const live = rows.flatMap(({ record_id }) => (record_id ? [record_id] : []));
      if (live.length === 1) {
        output.push({ handle: email, recordId: live[0] });
      } else if (
        rows.length === 0 &&
        declaration.access === 'write' &&
        createsRecords(declaration, mode) &&
        (mode === 'everyone' || (mode === 'contacted_first' && participant.contacted))
      ) {
        const values = prepareValues(
          object,
          {
            [field.name]: { primary: email, additional: [] },
            ...(name && participant.name
              ? {
                  [name.name]:
                    name.type === 'full_name'
                      ? { first: participant.name, last: '' }
                      : participant.name,
                }
              : {}),
          },
          'create',
        );
        const record = await insertRecord(tx, context, object);
        await writeFields(tx, context, object, record, values);
        output.push({ handle: email, recordId: record.id });
      } else output.push({ handle: email });
    }
    return output;
  }
  async taskSchema(caller: Caller, id: string) {
    const run = this.runtime(caller, id);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller);
      if (!policy.tasks) throw notFound('managed tasks');
      return taskSchema(await getSchema(tx, caller.workspaceId), policy).response;
    });
  }
  async tasks(
    caller: Caller,
    id: string,
    itemId: string,
    raw: z.input<typeof sourceTaskBatchSchema>,
  ) {
    this.runtime(caller, id);
    const input = sourceTaskBatchSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx, context) => {
        const binding = await this.binding(tx, caller),
          { manifest, policy } = await this.release(tx, caller);
        if (!policy.tasks || !manifest.source?.tasks) throw notFound('managed tasks');
        requireBindingCreation(policy.plan, manifest.source.tasks);
        await this.ingestionJob(tx, caller, policy, itemId);
        // Serialize first sightings across accounts before taking source-item or record locks.
        const identities = input.tasks.map((t) => t.externalId).sort();
        await tx`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['source-tasks', id])}, 0))`;
        const previous = await tx<
          { item_id: string }[]
        >`select distinct item_id from source_tasks where account_id=${binding.account_id} and external_id=any(${identities}::text[])`;
        const items = [...new Set([itemId, ...previous.map((t) => t.item_id)])].sort();
        await tx`select id from source_items where id=any(${items}::uuid[]) order by id for update`;
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId}`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        const [collision] = await tx<{ external_id: string }[]>`
          select external_id from source_tasks where installation_id = ${id}
            and account_id <> ${binding.account_id} and external_id = any(${identities}::text[])
          order by external_id limit 1`;
        if (collision)
          throw new AppError(
            409,
            'source_task_conflict',
            'Another account connected to this installation already imported this task.',
            { externalId: collision.external_id },
          );
        if ((item.task_write_revision ?? 0) !== input.expectedTaskRevision)
          throw conflict(
            'source_revision_conflict',
            'task snapshot was replaced; fetch current provider state again',
          );
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${itemId} and is_current`;
        if (
          (current?.id ?? null) !== input.expectedRevisionId ||
          (input.tasks.length && item.state !== 'live')
        )
          throw conflict('source_revision_conflict', 'task evidence is no longer current');
        if (current) await tx`select id from records where id=${current.event_id} for key share`;
        return reconcileTasks(
          tx,
          context,
          policy,
          binding,
          itemId,
          current?.event_id ?? null,
          input,
        );
      },
      {},
      { asPerson: false },
    );
  }
  async sync(
    caller: Caller,
    id: string,
    raw: z.input<typeof sourceEventSchema>,
  ): Promise<SourceResult> {
    const run = this.runtime(caller, id),
      input = sourceEventSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx, context) => {
        const binding = await this.binding(tx, caller),
          { manifest, policy } = await this.release(tx, caller);
        const [job] =
          await tx`select function_id,source_item_id from extension_jobs where id=${run.jobId}`;
        if (
          !policy.syncFunctionIds.includes(job?.function_id) ||
          job?.source_item_id !== input.sourceItemId
        )
          throw forbidden("only this item's registered ingestion job may import its evidence");
        // The per-item row precedes any event/participant/claim record locks.
        const [item] = await tx<
          Item[]
        >`select * from source_items where id=${input.sourceItemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['retracted', 'deleted'].includes(item.state))
          throw conflict(
            'source_retracted',
            'retracted source identities cannot be silently recreated',
          );
        const revisionKey =
          input.providerRevision !== undefined
            ? requestHash({ providerRevision: input.providerRevision })
            : undefined;
        const receiptFor = async (key: string) =>
          (
            await tx<SourceReceipt[]>`
          select content_digest, response, projection from source_receipts
          where item_id = ${item.id} and key = ${key}`
          )[0];
        const accepted = revisionKey ? await receiptFor(revisionKey) : undefined;
        const normalized = await this.normalize(
          tx,
          context,
          policy,
          input,
          accepted?.projection ?? undefined,
        );
        if (
          input.contentDigest &&
          input.contentDigest !== normalized.digest &&
          input.contentDigest !== normalized.submittedDigest
        )
          throw new AppError(
            422,
            'invalid_content_digest',
            'source content digest does not match canonical content',
          );
        const key =
          revisionKey ??
          requestHash({ digest: normalized.digest, expected: input.expectedRevisionId });
        const receipt = revisionKey ? accepted : await receiptFor(key);
        if (receipt) {
          if (receipt.content_digest !== normalized.digest)
            throw conflict(
              'source_revision_conflict',
              'provider revision was already imported with different content',
            );
          // A successful current lookup repairs availability without replacing immutable evidence.
          // Replaying a historical receipt must not mark a different current revision available.
          await tx`update source_items set state='live',updated_at=clock_timestamp() where id=${item.id} and state='unavailable'
            and exists(select 1 from source_revisions where item_id=${item.id} and id=${receipt.response.revisionId} and is_current)`;
          return receipt.projection
            ? {
                ...receipt.response,
                created: false,
                unchanged: true,
                invalidated: emptyInvalidation(),
              }
            : receipt.response;
        }
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${item.id} and is_current`;
        const order = compareRevision(
          policy.revisionOrder,
          input.providerRevision,
          item.provider_revision,
        );
        if (order !== null && order < 0 && current)
          return {
            sourceItemId: item.id,
            revisionId: current.id,
            eventId: current.event_id,
            created: false,
            unchanged: true,
            stale: true,
            contentDigest: current.content_digest,
            invalidated: emptyInvalidation(),
          };
        if ((current?.id ?? null) !== input.expectedRevisionId)
          throw conflict(
            'source_revision_conflict',
            'source changed; refetch provider state and current revision before retrying',
          );
        if (order === 0 && current && current.content_digest !== normalized.digest)
          throw conflict(
            'source_revision_conflict',
            'the same provider revision cannot contain different content',
          );
        let unchanged = current?.content_digest === normalized.digest;
        if (!unchanged && current && item.provider_revision) {
          const previous = await receiptFor(
            requestHash({ providerRevision: item.provider_revision }),
          );
          if (
            previous?.projection &&
            (input.event.content === undefined || previous.projection.includeContent !== false) &&
            Object.keys(input.event.fields).every(
              (key) => !normalized.projection?.fields[key] || !!previous.projection?.fields[key],
            )
          ) {
            const comparable = await this.normalize(
              tx,
              context,
              policy,
              input,
              previous.projection,
            );
            unchanged = previous.content_digest === comparable.digest;
          }
        }
        let result: SourceResult;
        if (current && unchanged) {
          result = {
            sourceItemId: item.id,
            revisionId: current.id,
            eventId: current.event_id,
            created: false,
            unchanged: true,
            contentDigest: current.content_digest,
            invalidated: emptyInvalidation(),
          };
        } else {
          if (!normalized.object)
            throw conflict('binding_unavailable', 'The approved event destination is unavailable.');
          requireBindingCreation(policy.plan, policy.event);
          for (const participant of normalized.participants)
            await tx`select pg_advisory_xact_lock(21066::int4,hashtext(${JSON.stringify([caller.workspaceId, participant.email])}))`;
          // Writers cite source records before taking target locks. Block new citations before retracting old claims.
          if (current) await tx`select id from records where id=${current.event_id} for update`;
          const participants = await this.bindParticipants(
            tx,
            context,
            policy,
            normalized.participants,
          );
          const event = await logEvent(
            tx,
            { ...context, sourceItemId: item.id },
            {
              type: normalized.object.name,
              channel: `source:${manifest.universalId}`,
              occurredAt: input.event.occurredAt,
              title: input.event.title,
              ...(input.event.summary !== undefined ? { summary: input.event.summary } : {}),
              fields: normalized.fields,
              participants,
              about: input.event.about,
            },
            { resolveHandles: false },
          );
          if (input.event.content !== undefined)
            await storeEventBody(tx, caller.workspaceId, {
              eventId: event.id,
              threadId: null,
              occurredAt: new Date(input.event.occurredAt),
              body: input.event.content,
            });
          if (current) {
            await context.changes?.capture(tx, current.event_id, 'supersede');
            await tx`update source_revisions set is_current=false where id=${current.id}`;
          }
          const [revision] = await tx<
            { id: string }[]
          >`insert into source_revisions(workspace_id,item_id,event_id,content_digest,provider_revision,previous_event_id)
          values(${caller.workspaceId},${item.id},${event.id},${normalized.digest},${input.providerRevision ?? null},${current?.event_id ?? null}) returning id`;
          if (!revision) throw new Error('source revision insert returned no row');
          const invalidated = current
            ? await retractEventClaims(tx, context, [current.event_id])
            : emptyInvalidation();
          result = {
            sourceItemId: item.id,
            revisionId: revision.id,
            eventId: event.id,
            created: true,
            unchanged: false,
            contentDigest: normalized.digest,
            ...(current ? { previousEventId: current.event_id } : {}),
            invalidated,
          };
        }
        await tx`update source_items set state='live',provider_revision=${input.providerRevision ?? item.provider_revision},updated_at=clock_timestamp() where id=${item.id}`;
        await tx`insert into source_receipts(workspace_id,item_id,key,content_digest,response,projection) values(${caller.workspaceId},${item.id},${key},${normalized.digest},${tx.json(jsonValue(result))},${normalized.projection ? tx.json(jsonValue(normalized.projection)) : null})`;
        return result;
      },
      {},
      { asPerson: false },
    );
  }
}
