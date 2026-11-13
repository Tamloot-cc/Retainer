import type { InputSchema } from '@retainer/extension';
import {
  functionScopes,
  functionSecrets,
  lifecycleInputSchema,
  nextOccurrence,
  SYSTEM_LIFECYCLE_FUNCTION_ID,
} from '@retainer/extension';
import { sourceScanSchema } from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import { overtaken, retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockPrivacyShared, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { getSchema } from '../schema/compiled.js';
import { loadSchemaState } from '../schema/load.js';
import { stableJson } from '../stable-json.js';
import {
  type RuntimeCatalog,
  requireRelease,
  resolveRelease,
  runnableReleases,
} from './availability.js';
import { failInstallation } from './lifecycle.js';
import { cancelRuns, lockExtension, lockQueue } from './locks.js';
import { type ContributionRow, retiredContributions } from './retired.js';

export type Lease = {
  connectionId?: string | null;
  connectionGeneration?: number | null;
  workspaceId: string;
  installationId: string;
  jobId: string;
  owner: string;
  fence: string;
};
export type Enqueue = { functionId: string; input: unknown; dedupeKey: string };
export type ClaimedJob = Lease & {
  connectionId?: string | null;
  connectionGeneration?: number | null;
  registrationName?: string;
  triggerKind: string;
  system: boolean;
  registrationId: string;
  scopes: ('read' | 'write')[];
  generation: number;
  releaseDigest: string;
  functionId: string;
  input: unknown;
  attempt: number;
  /** The handler's own budget. The lease runs RUN_GRACE_SECONDS longer, to record the outcome. */
  deadline: Date;
};
/** Time after a handler's deadline in which the coordinator may still acknowledge its run. */
export const RUN_GRACE_SECONDS = 15;
/** Shutdown releases per job that do not consume an attempt. */
const FREE_RELEASES = 3;
type Installation = {
  connection_id?: string | null;
  connection_generation?: number | null;
  connection_state?: string;
  connection_cleanup_live?: boolean;
  id: string;
  workspace_id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  generation: number;
  state: string;
  setup_kind: string;
  last_error: string | null;
  activated_at: Date | null;
  cleanup_deadline: Date | null;
  cleanup_live: boolean | null;
  granted_scopes: ('read' | 'write')[];
};
type Job = {
  connection_id: string | null;
  connection_generation: number | null;
  id: string;
  installation_id: string;
  generation: number;
  release_digest: string;
  function_id: string;
  trigger_kind: string;
  input: unknown;
  input_hash: string;
  dedupe_key: string;
  status: string;
  lease_owner: string | null;
  fence: string;
  lease_until: Date | null;
  run_until: Date | null;
  attempt: number;
  cycle_attempt: number;
  expires_at: Date;
  cause: string[];
  cause_depth: number | null;
};
/** A feed row as the dispatcher reads it. */
type DispatchedChange = {
  position: string;
  /** Null only for a schema-level change (no record; coalesces with nothing). */
  record_id: string | null;
  object_type_id: string;
  operation: string;
  field_keys: string[];
  cause: string[];
  cause_depth: number | null;
  origin_installation_id: string | null;
  related_record_ids: string[];
  merged_into_id: string | null;
};
/** Field-level operations; lifecycle changes (create, delete, merge…) always keep their own job. */
const COALESCED_OPERATIONS = ['update', 'review'];
/** Default cap on new change-trigger jobs per installation per minute (R9). */
export const CHANGE_ENQUEUES_PER_MINUTE = 500;
export type QueueLimits = { queued: number; kvBytes: number; changesPerMinute?: number };
const unavailable = () =>
  new AppError(409, 'installation_disabled', 'installation is disabled or its generation changed');
const runnable = (i: Installation, kind: string) =>
  i.connection_id
    ? kind === 'connect'
      ? i.state === 'active' && i.connection_state === 'connecting'
      : kind === 'disconnect'
        ? i.connection_state === 'disconnected' && i.connection_cleanup_live === true
        : i.state === 'active' && i.connection_state === 'active'
    : kind === 'install'
      ? ['installing', 'upgrading'].includes(i.state)
      : kind === 'uninstall'
        ? i.state === 'uninstalling' && i.cleanup_live === true
        : i.state === 'active';
const expired = () => new AppError(409, 'lease_expired', 'run lease expired or was replaced');
const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Validates the closed, bounded subset accepted by the build-time contract. */
export function validateInput(schema: InputSchema, value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError(422, 'invalid_input', 'input nesting exceeds 20');
  const fail: () => never = () => {
    throw new AppError(422, 'invalid_input', 'function input does not match its reviewed schema');
  };
  switch (schema.type) {
    case 'null':
      if (value !== null) fail();
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        (schema.maxLength !== undefined && value.length > schema.maxLength)
      )
        fail();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail();
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail();
      break;
    case 'array':
      if (
        !Array.isArray(value) ||
        !schema.items ||
        !schema.maxItems ||
        value.length > schema.maxItems
      )
        fail();
      for (const item of value) validateInput(schema.items, item, depth + 1);
      break;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
      for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) fail();
      for (const [key, child] of Object.entries(value)) {
        const property = schema.properties?.[key];
        if (!property || !Object.hasOwn(schema.properties ?? {}, key)) fail();
        validateInput(property, child, depth + 1);
      }
      break;
  }
}

/**
 * Lifecycle input is server-defined, not the function's `inputSchema`: setup gets
 * `{previousVersion}` (jobs queued before it existed carry `{}`); cleanup gets `{}`.
 */
export function validateLifecycleInput(
  kind: 'install' | 'uninstall' | 'connect' | 'disconnect',
  value: unknown,
): void {
  const valid =
    kind === 'install' || kind === 'connect'
      ? lifecycleInputSchema.safeParse(value).success
      : z.strictObject({}).safeParse(value).success;
  if (!valid)
    throw new AppError(422, 'invalid_input', 'lifecycle input does not match its server contract');
}

/** Durable queue. No method executes provider code or accepts a workspace-supplied executable. */
export class ExtensionQueue {
  /** What this process can run; discovery returns only work pinned to one of these. */
  readonly runnable: { registrations: string[]; digests: string[] };
  private readonly runnableKeys: ReadonlySet<string>;
  constructor(
    readonly sql: Sql,
    private readonly catalog: RuntimeCatalog,
    private readonly limits: QueueLimits = { queued: 10000, kvBytes: 1048576 },
    /**
     * Release digests with a deployed executable, when this process knows
     * them (the executor). Without it every resolvable release counts as runnable.
     */
    private readonly activation?: ReadonlySet<string>,
  ) {
    this.runnable = runnableReleases(catalog, activation);
    this.runnableKeys = new Set(
      this.runnable.digests.map((digest, i) => `${this.runnable.registrations[i]}:${digest}`),
    );
  }

  private async installation(
    tx: Tx,
    workspace: string,
    id: string,
    shared = true,
  ): Promise<Installation> {
    const [candidate] = await tx<
      Installation[]
    >`select *,cleanup_deadline>clock_timestamp() as cleanup_live from extension_installations where id=${id}`;
    if (!candidate) throw notFound('extension installation');
    await lockExtension(tx, workspace, candidate.registration_id, shared);
    await lockQueue(tx, workspace, id);
    const [current] = await tx<
      Installation[]
    >`select *,cleanup_deadline>clock_timestamp() as cleanup_live from extension_installations where id=${id}`;
    if (!current) throw notFound('extension installation');
    return current;
  }
  private async connection(
    tx: Tx,
    installation: Installation,
    id?: string | null,
  ): Promise<Installation> {
    if (!id) return installation;
    const [row] =
      await tx`select generation,state,connected_at,disconnected_at+interval '24 hours'>clock_timestamp() as cleanup_live
      from extension_connections where id=${id} and installation_id=${installation.id}`;
    return {
      ...installation,
      connection_id: id,
      connection_generation: row?.generation ?? -1,
      connection_state: row?.state ?? 'disconnected',
      connection_cleanup_live: row?.cleanup_live ?? false,
      activated_at: row?.connected_at ?? installation.activated_at,
    };
  }
  private manifest(installation: Installation) {
    return requireRelease(this.catalog, installation);
  }
  /**
   * Defense in depth behind discovery's filter: null when this process cannot
   * run the pinned release, so the caller leaves the work as it is.
   */
  private runnableRelease(installation: Installation) {
    if (!this.runnableKeys.has(`${installation.registration_id}:${installation.release_digest}`))
      return null;
    const resolution = resolveRelease(this.catalog, installation);
    return resolution.available ? resolution.manifest : null;
  }
  private async insert(
    tx: Tx,
    installation: Installation,
    input: Enqueue,
    cause: string[],
    kind:
      | 'job'
      | 'schedule'
      | 'install'
      | 'uninstall'
      | 'connect'
      | 'disconnect'
      | 'change' = 'job',
    setupChild = false,
    depth = cause.length,
  ) {
    if (
      !runnable(installation, kind) &&
      !(
        setupChild &&
        kind === 'job' &&
        (installation.connection_id
          ? installation.connection_state === 'connecting'
          : ['installing', 'upgrading'].includes(installation.state))
      )
    )
      throw unavailable();
    if (!input.dedupeKey || input.dedupeKey.length > 500)
      throw new AppError(422, 'invalid_input', 'dedupe key must contain 1–500 characters');
    const manifest = this.manifest(installation);
    if (
      manifest.connection === 'member' &&
      !installation.connection_id &&
      !['install', 'uninstall'].includes(kind)
    )
      throw new AppError(
        422,
        'connection_required',
        'member jobs require a connection inherited from their parent',
      );
    const fn = manifest.functions.find((f) => f.universalId === input.functionId);
    const system =
      input.functionId === SYSTEM_LIFECYCLE_FUNCTION_ID && ['install', 'uninstall'].includes(kind);
    if (!system && fn?.trigger.kind !== kind)
      throw new AppError(422, 'invalid_input', 'only registered job functions can be enqueued');
    if (['install', 'uninstall', 'connect', 'disconnect'].includes(kind))
      validateLifecycleInput(
        kind as 'install' | 'uninstall' | 'connect' | 'disconnect',
        input.input,
      );
    else if (fn) validateInput(fn.inputSchema, input.input);
    let sourceItemId: string | null = null;
    if (manifest.source?.syncFunctionIds.includes(input.functionId)) {
      sourceItemId = z.uuid().parse((input.input as { sourceItemId?: unknown }).sourceItemId);
      const [item] =
        await tx`select s.id from source_items s join source_bindings b on b.account_id=s.account_id
        where s.id=${sourceItemId} and s.state<> 'erased' and (${!!manifest.source?.tasks} or s.state not in ('retracted','deleted')) and b.installation_id=${installation.id} and b.generation=${installation.generation} and b.connection_id is not distinct from ${installation.connection_id ?? null}::uuid`;
      if (!item) throw notFound('source item');
    }
    if (Buffer.byteLength(stableJson(input.input)) > 65536)
      throw new AppError(413, 'quota_exceeded', 'job input exceeds 64 KiB');
    const hash = requestHash({ functionId: input.functionId, input: input.input, cause });
    const [existing] = await tx<
      Job[]
    >`select * from extension_jobs where installation_id=${installation.id}
      and generation=${installation.generation} and connection_id is not distinct from ${installation.connection_id ?? null}::uuid
      and connection_generation is not distinct from ${installation.connection_generation ?? null}::integer and dedupe_key=${input.dedupeKey}`;
    if (existing) {
      if (existing.input_hash !== hash)
        throw conflict('idempotency_conflict', 'job dedupe key was used for a different operation');
      return existing.id;
    }
    const [count] = await tx<{ count: number }[]>`select count(*)::int as count from extension_jobs
      where installation_id=${installation.id} and status in ('queued','running')`;
    if ((count?.count ?? 0) >= this.limits.queued)
      throw new AppError(429, 'quota_exceeded', 'installation job queue is full', {
        retryAfterSeconds: 60,
      });
    const [job] = await tx<{ id: string }[]>`insert into extension_jobs
      (workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,function_id,input,input_hash,dedupe_key,cause,cause_depth,trigger_kind,source_item_id)
      values (${installation.workspace_id},${installation.id},${installation.connection_id ?? null},${installation.connection_generation ?? null},${installation.generation},${installation.release_digest},
        ${input.functionId},${tx.json(jsonValue(input.input))},${hash},${input.dedupeKey},${tx.json(cause)},${depth},${kind},${sourceItemId}) returning id`;
    if (!job) throw new Error('job insert returned no row');
    return job.id;
  }
  /**
   * Accepts one change for one handler. While a job for the same function and
   * record is still queued and has never started, the change is folded into
   * it: the job moves to the latest position and snapshot, keeps the union of
   * changed keys and related records (so a relinked record is still
   * recomputed) and the union of cause chains (so every installation behind
   * any absorbed change stays excluded and A → B → A remains blocked).
   * Handlers read current data, so the superseded positions need no job of
   * their own (§9.4). Only an update/review change coalesces, and only into
   * the record's newest live (queued or running) job, when that job is an
   * unstarted update/review of the same object type: folding into an older
   * job would run the change before a later lifecycle job (update, delete,
   * undelete, update must not end on the delete). The job's depth is the
   * deeper of the two, so coalescing never manufactures a depth breach.
   * Otherwise a new job is queued, unless the installation already queued
   * its per-minute share.
   */
  private async acceptChange(
    tx: Tx,
    installation: Installation,
    functionId: string,
    row: DispatchedChange,
  ): Promise<'queued' | 'coalesced'> {
    const workspace = installation.workspace_id,
      dedupeKey = `change:${row.position}:${functionId}`;
    if (COALESCED_OPERATIONS.includes(row.operation)) {
      const [newest] = await tx<
        {
          id: string;
          cause: string[];
          depth: number;
          status: string;
          attempt: number;
          generation: number;
          release_digest: string;
          object_type_id: string | null;
          operation: string | null;
        }[]
      >`select id,cause,coalesce(cause_depth,jsonb_array_length(cause)) as depth,status,attempt,generation,release_digest,
          change_snapshot->>'object_type_id' as object_type_id,change_snapshot->>'operation' as operation
        from extension_jobs where installation_id=${installation.id} and function_id=${functionId}
          and (change_snapshot->>'record_id')=${row.record_id} and status in ('queued','running') and trigger_kind='change'
        order by (change_snapshot->>'position')::bigint desc,created_at desc,id desc limit 1 for update`;
      const target =
        newest &&
        newest.status === 'queued' &&
        newest.attempt === 0 &&
        newest.generation === installation.generation &&
        newest.release_digest === installation.release_digest &&
        newest.object_type_id === row.object_type_id &&
        COALESCED_OPERATIONS.includes(newest.operation ?? '')
          ? newest
          : undefined;
      if (target) {
        const cause = [...new Set([...target.cause, ...row.cause])],
          depth = Math.max(target.depth, row.cause_depth ?? row.cause.length),
          input = { changePosition: row.position };
        const [moved] = await tx<
          { id: string }[]
        >`update extension_jobs j set input=${tx.json(input)},
            input_hash=${requestHash({ functionId, input, cause })},dedupe_key=${dedupeKey},cause=${tx.json(cause)},cause_depth=${depth},
            change_snapshot=(to_jsonb(c)-'workspace_id'-'created_at')||jsonb_build_object(
              'position',c.position::text,'cause',${tx.json(cause)}::jsonb,'cause_depth',${depth}::int,
              'field_keys',(select coalesce(jsonb_agg(distinct k order by k),'[]'::jsonb) from (
                select jsonb_array_elements_text(j.change_snapshot->'field_keys') as k
                union select jsonb_array_elements_text(c.field_keys)) keys),
              'related_record_ids',(select coalesce(jsonb_agg(distinct r order by r),'[]'::jsonb) from (
                select jsonb_array_elements_text(j.change_snapshot->'related_record_ids') as r
                union select jsonb_array_elements_text(c.related_record_ids)) related)),
            expires_at=greatest(j.expires_at,clock_timestamp()+interval '24 hours'),updated_at=clock_timestamp()
          from record_changes c where j.id=${target.id} and c.workspace_id=${workspace} and c.position=${row.position}::bigint
          returning j.id`;
        // Pruning can commit after the retention check; never point a job at a missing change.
        if (!moved)
          throw conflict(
            'cursor_expired',
            'change dispatch history expired; rescan current records before restarting the trigger',
          );
        return 'coalesced';
      }
    }
    const [existing] =
      await tx`select 1 from extension_jobs where installation_id=${installation.id} and generation=${installation.generation} and dedupe_key=${dedupeKey}`;
    if (!existing) {
      const perMinute = this.limits.changesPerMinute ?? CHANGE_ENQUEUES_PER_MINUTE;
      const [recent] = await tx<
        { count: number }[]
      >`select count(*)::int as count from extension_jobs
        where workspace_id=${workspace} and installation_id=${installation.id} and created_at>clock_timestamp()-interval '1 minute'
          and trigger_kind='change'`;
      // Twenty drops trigger jobs past its per-app cap; here the change waits
      // behind the dispatch cursor instead, so nothing is lost (R9).
      if ((recent?.count ?? 0) >= perMinute)
        throw new AppError(429, 'trigger_throttled', 'change trigger enqueue rate exceeded', {
          retryAfterSeconds: 60,
        });
    }
    const changeJobId = await this.insert(
      tx,
      installation,
      { functionId, input: { changePosition: row.position }, dedupeKey },
      row.cause,
      'change',
      false,
      row.cause_depth ?? row.cause.length,
    );
    const [snapshot] = await tx<{ present: boolean }[]>`with copied as (
        update extension_jobs j set change_snapshot=(to_jsonb(c)-'workspace_id'-'created_at')||jsonb_build_object('position',c.position::text)
        from record_changes c where j.id=${changeJobId} and j.change_snapshot is null and c.workspace_id=${workspace} and c.position=${row.position}::bigint
        returning j.id)
      select exists(select 1 from copied) or exists(select 1 from extension_jobs where id=${changeJobId} and change_snapshot is not null) as present`;
    // Pruning can commit after the retention check above. A job
    // without its change could never read it, so roll back the whole
    // dispatch rather than advance the cursor past it.
    if (!snapshot?.present)
      throw conflict(
        'cursor_expired',
        'change dispatch history expired; rescan current records before restarting the trigger',
      );
    return 'queued';
  }
  /** Trusted verified ingress only; receipt and source reservation share the caller's transaction. */
  async enqueueWebhook(tx: Tx, workspace: string, id: string, generation: number, input: Enqueue) {
    const installation = await this.installation(tx, workspace, id);
    if (installation.generation !== generation) throw unavailable();
    if (!this.manifest(installation).source?.syncFunctionIds.includes(input.functionId))
      throw new AppError(403, 'forbidden', 'webhook target must be a pinned source sync function');
    return { id: await this.insert(tx, installation, input, []) };
  }
  /**
   * Trusted control transaction only. Runtime payloads never select lifecycle kinds.
   * Setup receives the release version installed before it (null on a first install).
   */
  async enqueueLifecycle(
    tx: Tx,
    workspace: string,
    id: string,
    kind: 'install' | 'uninstall',
    previousVersion: string | null = null,
  ) {
    const installation = await this.installation(tx, workspace, id);
    const functions = this.manifest(installation).functions.filter(
      (fn) => fn.trigger.kind === kind,
    );
    const ids = functions.length
      ? functions.map((fn) => fn.universalId)
      : [SYSTEM_LIFECYCLE_FUNCTION_ID];
    for (const functionId of ids)
      await this.insert(
        tx,
        installation,
        {
          functionId,
          input: kind === 'install' ? { previousVersion } : {},
          dedupeKey: `lifecycle:${kind}:${functionId}`,
        },
        [],
        kind,
      );
  }
  async enqueueConnectionLifecycle(
    tx: Tx,
    workspace: string,
    id: string,
    cid: string,
    previousVersion: string | null = null,
  ) {
    let installation = await this.installation(tx, workspace, id);
    const manifest = this.manifest(installation);
    const hook = manifest.functions.find((fn) => fn.trigger.kind === 'connect');
    if (manifest.connection !== 'member' || !hook)
      throw new AppError(422, 'invalid_connection', 'member connect hook missing');
    installation = await this.connection(tx, installation, cid);
    return this.insert(
      tx,
      installation,
      {
        functionId: hook.universalId,
        input: { previousVersion },
        dedupeKey: `connect:${installation.connection_generation}`,
      },
      [],
      'connect',
    );
  }
  /** Trusted ingress/scheduler entry. Runtime children use checkpoint so cause is server-derived. */
  async enqueue(workspace: string, installationId: string, input: Enqueue) {
    return inWorkspace(this.sql, workspace, async (tx) => {
      await lockSchemaShared(tx, workspace);
      const installation = await this.installation(tx, workspace, installationId);
      return { id: await this.insert(tx, installation, input, []) };
    });
  }
  /** Trusted dispatcher only. Matching jobs and their cursor commit in the same transaction. */
  async dispatchChanges(workspace: string, id: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('invalid change batch limit');
    let admittedGeneration: number | undefined;
    try {
      return await inWorkspace(this.sql, workspace, async (tx) => {
        await lockPrivacyShared(tx, workspace);
        await lockSchemaShared(tx, workspace);
        const installation = await this.installation(tx, workspace, id);
        admittedGeneration = installation.generation;
        if (installation.state !== 'active') return { queued: 0, blocked: 0 };
        const manifest = this.runnableRelease(installation);
        if (!manifest) return { queued: 0, blocked: 0 };
        const schema = await getSchema(tx, workspace);
        const bound = (fn: (typeof manifest.functions)[number]) => {
          if (fn.trigger.kind !== 'change') return false;
          const object = schema.objectsByUniversalId.get(fn.trigger.objectId);
          return (
            object?.state.status === 'active' &&
            !object.hidden &&
            fn.trigger.fieldIds.every((fid) =>
              object.activeFields.some((field) => field.universalId === fid),
            )
          );
        };
        let handlers = manifest.functions.filter((fn) => fn.trigger.kind === 'change');
        // A trigger on a contribution the workspace deleted never fires, as
        // the install plan promised; other unresolved bindings still fail.
        if (handlers.some((fn) => !bound(fn))) {
          const retired = retiredContributions(
            await loadSchemaState(tx, workspace),
            manifest,
            await tx<
              ContributionRow[]
            >`select kind,universal_id,element_id,definition from extension_contributions where installation_id=${id}`,
          );
          handlers = handlers.filter(
            (fn) =>
              bound(fn) ||
              fn.trigger.kind !== 'change' ||
              ![fn.trigger.objectId, ...fn.trigger.fieldIds].some((rid) => retired.has(rid)),
          );
        }
        if (!handlers.length) return { queued: 0, blocked: 0 };
        const [checkpoint] = await tx<
          { position: string; generation: number }[]
        >`select position::text,generation from change_dispatch where installation_id=${id} for update`;
        if (!checkpoint || checkpoint.generation !== installation.generation)
          throw conflict(
            'dispatcher_not_initialized',
            'change dispatch must be initialized by setup',
          );
        const [counter] = await tx<
          { position: string; retained_after: string }[]
        >`select position::text,retained_after::text from change_counters where workspace_id=${workspace}`;
        const floor = await retainedFloor(
          tx,
          workspace,
          counter?.position ?? '0',
          counter?.retained_after ?? '0',
        );
        if (BigInt(checkpoint.position) < BigInt(floor))
          throw conflict(
            'cursor_expired',
            'change dispatch history expired; rescan current records before restarting the trigger',
          );
        // Order by the column, not the `position::text` alias, which sorts as text.
        const rows = await tx<DispatchedChange[]>`
        select position::text,record_id,object_type_id,operation,field_keys,cause,cause_depth,origin_installation_id,related_record_ids,merged_into_id from record_changes
        where position>${checkpoint.position}::bigint order by record_changes.position limit ${limit}`;
        if (await overtaken(tx, workspace, checkpoint.position))
          throw conflict(
            'cursor_expired',
            'change dispatch history expired; rescan current records before restarting the trigger',
          );
        const relatedIds = [
          ...new Set(
            rows.flatMap((row) => [
              ...row.related_record_ids,
              ...(row.merged_into_id ? [row.merged_into_id] : []),
            ]),
          ),
        ];
        const related = relatedIds.length
          ? await tx<{ id: string; object_type_id: string }[]>`select id,object_type_id from records
        where id=any(${relatedIds}::uuid[]) and deleted_at is null and merged_into_id is null and private_to_user is null`
          : [];
        const relatedTypes = new Map(related.map((record) => [record.id, record.object_type_id]));
        let queued = 0,
          blocked = 0,
          coalesced = 0,
          cycles = 0,
          dispatched: string | undefined,
          deferred: 'quota_exceeded' | 'trigger_throttled' | undefined;
        for (const row of rows) {
          // Each change commits with all its jobs or none. At the queued-job
          // quota or the enqueue throttle the batch stops before that change
          // and keeps what it accepted, so the cursor resumes there later.
          const counts = { queued: 0, blocked: 0, coalesced: 0, cycles: 0 };
          try {
            await tx.savepoint(async (sp) => {
              for (const fn of handlers) {
                if (fn.trigger.kind !== 'change') continue;
                const object = schema.objectsByUniversalId.get(fn.trigger.objectId);
                if (object?.state.status !== 'active' || object.hidden)
                  throw conflict(
                    'schema_binding_conflict',
                    'change trigger object binding is unavailable',
                  );
                const keys = fn.trigger.fieldIds.map(
                  (id) => object.activeFields.find((field) => field.universalId === id)?.key,
                );
                if (keys.some((key) => key === undefined))
                  throw conflict(
                    'schema_binding_conflict',
                    'change trigger field binding is unavailable',
                  );
                // A field-scoped trigger reacts to updates, reviews and
                // schema changes only when one of its fields is named. A
                // trigger listing its operations fires only on those, and on
                // an update only when a watched field changed.
                const watched =
                  !fn.trigger.fieldIds.length ||
                  keys.some((key) => row.field_keys.includes(key as string));
                const operations = fn.trigger.operations as readonly string[] | undefined;
                const direct =
                  row.object_type_id === object.id &&
                  (operations
                    ? operations.includes(row.operation) && (row.operation === 'create' || watched)
                    : !['update', 'review', 'schema'].includes(row.operation) || watched);
                const relationChanged = row.field_keys.some((key) =>
                  schema.objectsById
                    .get(row.object_type_id)
                    ?.activeFields.some((field) => field.key === key && field.type === 'relation'),
                );
                const linksAffected =
                  !['update', 'review'].includes(row.operation) || relationChanged;
                const indirect =
                  fn.trigger.related !== false &&
                  linksAffected &&
                  [
                    ...row.related_record_ids,
                    ...(row.merged_into_id ? [row.merged_into_id] : []),
                  ].some((id) => relatedTypes.get(id) === object.id);
                if (!direct && !indirect) continue;
                // Exclusion uses the whole chain; the depth cap counts only
                // server-derived hops, not a chain inherited by a standalone app.
                if (row.cause.includes(id) || (row.cause_depth ?? row.cause.length) >= 8) {
                  counts.blocked++;
                  if (row.origin_installation_id !== id) counts.cycles++;
                  continue;
                }
                const accepted = await this.acceptChange(sp, installation, fn.universalId, row);
                counts[accepted]++;
              }
            });
          } catch (error) {
            if (
              error instanceof AppError &&
              (error.code === 'quota_exceeded' || error.code === 'trigger_throttled')
            ) {
              deferred = error.code;
              break;
            }
            throw error;
          }
          queued += counts.queued;
          blocked += counts.blocked;
          coalesced += counts.coalesced;
          cycles += counts.cycles;
          dispatched = row.position;
        }
        if (dispatched)
          await tx`update change_dispatch set position=${dispatched}::bigint,blocked_cycles=blocked_cycles+${blocked} where installation_id=${id}`;
        if (cycles)
          await tx`update extension_installations set last_error='trigger_cycle_blocked',connection_health='degraded' where id=${id}`;
        if (deferred)
          await tx`update extension_installations set last_error=${deferred},connection_health='degraded' where id=${id}`;
        else if (!cycles)
          await tx`update extension_installations set connection_health='ok',last_error=null where id=${id}
        and last_error in ('quota_exceeded','trigger_throttled','cursor_expired','schema_binding_conflict','dispatch_unavailable')
        and not exists(select 1 from extension_jobs where installation_id=${id} and generation=${installation.generation} and status='failed')`;
        return {
          queued,
          blocked,
          ...(coalesced ? { coalesced } : {}),
          ...(deferred ? { deferred } : {}),
        };
      });
    } catch (error) {
      const failedGeneration = admittedGeneration;
      if (failedGeneration !== undefined)
        try {
          await inWorkspace(this.sql, workspace, async (tx) => {
            await lockSchemaShared(tx, workspace);
            const [current] = await tx<
              { registration_id: string }[]
            >`select registration_id from extension_installations where id=${id}`;
            if (!current) return;
            await lockExtension(tx, workspace, current.registration_id, true);
            const code =
              error instanceof AppError &&
              ['quota_exceeded', 'cursor_expired', 'schema_binding_conflict'].includes(error.code)
                ? error.code
                : 'dispatch_unavailable';
            await tx`update extension_installations set connection_health='degraded',last_error=${code} where id=${id} and generation=${failedGeneration} and state='active'`;
          });
        } catch {
          /* The durable cursor remains pending even if diagnostics cannot be updated. */
        }
      throw error;
    }
  }
  /** Coordinator discovers IDs only; discovery pool has only the security-definer capability. */
  async discover(discoverySql: Sql, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('invalid discovery limit');
    const { registrations, digests } = this.runnable;
    return discoverySql<{ workspace_id: string; job_id: string }[]>`
      select * from retainer_extension_jobs_due(${limit},${registrations}::uuid[],${digests}::text[])`;
  }
  async discoverChanges(discoverySql: Sql, after: string | null) {
    const { registrations, digests } = this.runnable;
    return discoverySql<{ workspace_id: string; installation_id: string }[]>`
      select * from retainer_extension_changes_due(${after}::uuid,1000,${registrations}::uuid[],${digests}::text[])`;
  }
  /**
   * Schedules for runnable releases, plus uninstall cleanup for any release:
   * an expired cleanup deadline always ends in `uninstalled`, and cleanup a
   * release cannot run here is skipped (startCleanup).
   */
  async maintain(discoverySql: Sql) {
    const { registrations, digests } = this.runnable;
    const due = await discoverySql<{ workspace_id: string; installation_id: string }[]>`
      select * from retainer_extension_maintenance_due(1000,${registrations}::uuid[],${digests}::text[])`;
    for (const item of due) {
      let generation: number | undefined;
      try {
        await inWorkspace(this.sql, item.workspace_id, async (tx) => {
          await lockSchemaShared(tx, item.workspace_id);
          const installation = await this.installation(
            tx,
            item.workspace_id,
            item.installation_id,
            false,
          );
          generation = installation.generation;
          if (installation.state !== 'uninstalling') return;
          const [expired] =
            await tx`select 1 where ${installation.cleanup_deadline}::timestamptz<=clock_timestamp()`;
          if (!expired) {
            await this.startCleanup(tx, installation);
            return;
          }
          await cancelRuns(tx, installation.id);
          await tx`update extension_installations set state='uninstalled',generation=generation+1,
            last_error='cleanup_deadline_expired',updated_at=now() where id=${installation.id}`;
          await tx`select retainer_finish_extension_cleanup(${installation.id}::uuid)`;
        });
        await this.scheduleTick(item.workspace_id, item.installation_id);
      } catch (error) {
        // A bad pinned release or a failed cleanup must not block healthy installations.
        // Keep the occurrence pending and diagnose only the generation we inspected.
        const failedGeneration = generation;
        if (failedGeneration === undefined) continue;
        try {
          await inWorkspace(this.sql, item.workspace_id, async (tx) => {
            await lockSchemaShared(tx, item.workspace_id);
            const current = await this.installation(
              tx,
              item.workspace_id,
              item.installation_id,
              false,
            );
            const code =
              error instanceof AppError && error.code === 'quota_exceeded'
                ? 'quota_exceeded'
                : 'maintenance_unavailable';
            await tx`update extension_installations set connection_health='degraded',last_error=${code}
              where id=${current.id} and generation=${failedGeneration} and state in ('active','uninstalling')`;
          });
        } catch {
          /* Pending maintenance is durable even when diagnostics cannot be written. */
        }
      }
    }
  }

  /**
   * Queues cleanup for an installation a workspace deletion moved to
   * `uninstalling` (workspace-deletion.ts), which queues none itself. As in
   * an admin uninstall, a release that cannot run here (unresolvable, or
   * hosted without an active executable) is uninstalled directly, recorded
   * as `cleanup_unavailable`, and a standalone one is finished; neither is
   * visited again. Under the installation lock (exclusive) and queue lock.
   */
  private async startCleanup(tx: Tx, installation: Installation) {
    const [queued] = await tx`select 1 from extension_jobs where installation_id=${installation.id}
      and generation=${installation.generation} and trigger_kind='uninstall' limit 1`;
    if (queued) return;
    const resolution = resolveRelease(this.catalog, installation);
    const runnable =
      resolution.available &&
      resolution.manifest.execution === 'hosted' &&
      (!this.activation || this.activation.has(installation.release_digest));
    if (runnable) {
      await this.enqueueLifecycle(tx, installation.workspace_id, installation.id, 'uninstall');
      return;
    }
    const standalone = resolution.available && resolution.manifest.execution === 'standalone';
    await tx`update extension_installations set state='uninstalled',cleanup_deadline=null,
      last_error=${standalone ? null : 'cleanup_unavailable'},updated_at=now() where id=${installation.id}`;
  }

  async claim(workspace: string, id: string, owner: string): Promise<ClaimedJob | null> {
    if (!owner || owner.length > 200) throw new Error('invalid lease owner');
    return inWorkspace(this.sql, workspace, async (tx) => {
      await lockSchemaShared(tx, workspace);
      const [candidate] = await tx<Job[]>`select * from extension_jobs where id=${id}`;
      if (!candidate) return null;
      let installation = await this.installation(tx, workspace, candidate.installation_id, false);
      installation = await this.connection(tx, installation, candidate.connection_id);
      const [job] = await tx<Job[]>`select * from extension_jobs where id=${id}
        and ((status='queued' and available_at<=now()) or (status='running' and lease_until<=clock_timestamp())) for update skip locked`;
      if (!job) return null;
      if (
        job.generation !== installation.generation ||
        job.release_digest !== installation.release_digest
      ) {
        await tx`update extension_jobs set status='cancelled',code='installation_disabled',lease_until=null where id=${id}`;
        await tx`update extension_attempts set status='cancelled',code='installation_disabled',finished_at=now()
          where job_id=${id} and finished_at is null`;
        return null;
      }
      if (
        job.connection_id &&
        (job.connection_generation !== installation.connection_generation ||
          !runnable(installation, job.trigger_kind))
      ) {
        await tx`update extension_jobs set status='cancelled',code='connection_disconnected',lease_owner=null,lease_until=null,run_until=null,updated_at=now() where id=${id}`;
        await tx`update extension_attempts set status='cancelled',code='connection_disconnected',finished_at=now() where job_id=${id} and finished_at is null`;
        return null;
      }
      if (!runnable(installation, job.trigger_kind)) return null;
      const [exhausted] =
        await tx`select 1 where ${job.expires_at}<=clock_timestamp() or ${job.cycle_attempt}>=10`;
      if (exhausted) {
        await tx`update extension_jobs set status='failed',code='retry_exhausted',lease_until=null where id=${id}`;
        await tx`update extension_attempts set status='failed',code='retry_exhausted',finished_at=now() where job_id=${id} and finished_at is null`;
        await this.finishLifecycle(tx, installation, job, 'failed', 'retry_exhausted');
        return null;
      }
      const manifest = this.runnableRelease(installation);
      if (!manifest) return null;
      if (
        manifest.connection === 'member' &&
        !job.connection_id &&
        !['install', 'uninstall'].includes(job.trigger_kind)
      ) {
        await tx`update extension_jobs set status='failed',code='connection_required' where id=${id}`;
        return null;
      }
      const fn = manifest.functions.find((f) => f.universalId === job.function_id);
      const system =
        job.function_id === SYSTEM_LIFECYCLE_FUNCTION_ID &&
        ['install', 'uninstall'].includes(job.trigger_kind);
      if (!system && fn?.trigger.kind !== job.trigger_kind) {
        await tx`update extension_jobs set status='failed',code='incompatible_runtime',lease_owner=null,lease_until=null,run_until=null where id=${id}`;
        await tx`update extension_attempts set status='failed',code='incompatible_runtime',finished_at=now() where job_id=${id} and finished_at is null`;
        await this.finishLifecycle(tx, installation, job, 'failed', 'incompatible_runtime');
        return null;
      }
      const timeout = fn?.timeoutSeconds ?? 30;
      // Spec 8: the run gets the intersection of the grant and the function's needs,
      // and only the secrets its function declares.
      const scopes = fn
        ? functionScopes(manifest, fn).filter((s) => installation.granted_scopes.includes(s))
        : installation.granted_scopes;
      const secrets = fn ? functionSecrets(manifest, fn) : [];
      if (!scopes.length) {
        await tx`update extension_jobs set status='failed',code='forbidden',lease_owner=null,lease_until=null,run_until=null where id=${id}`;
        await tx`update extension_attempts set status='failed',code='forbidden',finished_at=now() where job_id=${id} and finished_at is null`;
        await this.finishLifecycle(tx, installation, job, 'failed', 'forbidden');
        return null;
      }
      const [other] =
        await tx`select id from extension_jobs where installation_id=${installation.id} and connection_id is not distinct from ${installation.connection_id ?? null}::uuid and status='running' and id<>${id}`;
      if (other) return null;
      const [slot] = await tx<
        { available: boolean }[]
      >`select retainer_extension_slot_available(${id}::uuid) as available`;
      if (!slot?.available) return null;
      // An old attempt remains visible even when its worker disappeared.
      await tx`update extension_attempts set status='expired',code='lease_expired',finished_at=now() where job_id=${id} and finished_at is null`;
      // The handler gets exactly its timeout; the lease keeps a short grace after it so the
      // coordinator can still record a timeout as an ordinary retry instead of being fenced.
      const [claimed] = await tx<
        (Job & { handler_deadline: Date })[]
      >`update extension_jobs set status='running',lease_owner=${owner},run_secrets=${secrets}::text[],
        fence=fence+1,lease_until=clock_timestamp()+least(60,${timeout + RUN_GRACE_SECONDS})*interval '1 second',run_until=clock_timestamp()+${timeout + RUN_GRACE_SECONDS}*interval '1 second',attempt=attempt+1,cycle_attempt=cycle_attempt+1,updated_at=now()
        where id=${id} returning *,run_until-${RUN_GRACE_SECONDS}*interval '1 second' as handler_deadline`;
      if (!claimed) throw new Error('claim returned no row');
      await tx`insert into extension_attempts(workspace_id,job_id,attempt,fence,status)
        values(${workspace},${id},${claimed.attempt},${claimed.fence},'running')`;
      await tx`update extension_installations set last_claimed_at=clock_timestamp() where id=${installation.id}`;
      if (job.connection_id)
        await tx`update extension_connections set last_claimed_at=clock_timestamp() where id=${job.connection_id}`;
      return {
        connectionId: job.connection_id,
        connectionGeneration: job.connection_generation,
        registrationName: manifest.name.replace(/^./, (letter) => letter.toUpperCase()),
        workspaceId: workspace,
        installationId: installation.id,
        jobId: id,
        owner,
        fence: String(claimed.fence),
        triggerKind: claimed.trigger_kind,
        system,
        registrationId: installation.registration_id,
        scopes,
        generation: claimed.generation,
        releaseDigest: claimed.release_digest,
        functionId: claimed.function_id,
        input: claimed.input,
        attempt: claimed.attempt,
        deadline: claimed.handler_deadline,
      };
    });
  }
  private async withLease<T>(
    lease: Lease,
    fn: (tx: Tx, installation: Installation, job: Job) => Promise<T>,
    exclusive = false,
  ) {
    return inWorkspace(this.sql, lease.workspaceId, async (tx) => {
      await lockSchemaShared(tx, lease.workspaceId);
      let installation = await this.installation(
        tx,
        lease.workspaceId,
        lease.installationId,
        !exclusive,
      );
      if (
        !['active', 'installing', 'upgrading', 'uninstalling'].includes(installation.state) &&
        !(['disabled', 'uninstalled'].includes(installation.state) && lease.connectionId)
      )
        throw unavailable();
      const [job] = await tx<
        Job[]
      >`select * from extension_jobs where id=${lease.jobId} and installation_id=${lease.installationId}
        and status='running' and lease_owner=${lease.owner} and fence=${lease.fence}::bigint
        and generation=${installation.generation} and release_digest=${installation.release_digest} and lease_until>clock_timestamp() and run_until>clock_timestamp() for update`;
      if (!job) throw expired();
      if (
        (job.connection_id ?? null) !== (lease.connectionId ?? null) ||
        (job.connection_generation ?? null) !== (lease.connectionGeneration ?? null)
      )
        throw expired();
      installation = await this.connection(tx, installation, job.connection_id);
      if (job.connection_id && job.connection_generation !== installation.connection_generation)
        throw expired();
      if (!runnable(installation, job.trigger_kind)) throw unavailable();
      return fn(tx, installation, job);
    });
  }
  async renew(lease: Lease) {
    return this.withLease(lease, async (tx) => {
      const [row] = await tx<
        { deadline: Date }[]
      >`update extension_jobs set lease_until=least(run_until,clock_timestamp()+interval '60 seconds'),updated_at=now() where id=${lease.jobId} returning lease_until as deadline`;
      return row;
    });
  }
  private async finishLifecycle(
    tx: Tx,
    installation: Installation,
    job: Job,
    status: string,
    code: string | null,
  ) {
    if (job.connection_id) {
      if (job.connection_generation !== installation.connection_generation) return false;
      if (status === 'failed') {
        await failInstallation(tx, installation, job, code ?? 'run_failed');
        return false;
      }
      if (status !== 'succeeded') return false;
      if (job.trigger_kind === 'connect') {
        if (this.manifest(installation).source) {
          const [verified] =
            await tx`select 1 from source_bindings where installation_id=${installation.id} and connection_id=${job.connection_id} and generation=${installation.generation}`;
          if (!verified) {
            await tx`update extension_jobs set status='failed',code='source_verification_required' where id=${job.id}`;
            await failInstallation(tx, installation, job, 'source_verification_required');
            return false;
          }
        }
        await tx`update extension_connections set state='active',health='ok',last_error=null,connected_at=clock_timestamp() where id=${job.connection_id} and generation=${job.connection_generation}`;
        return true;
      }
      if (job.trigger_kind === 'disconnect' && installation.state === 'uninstalling') {
        const [pending] =
          await tx`select 1 from extension_jobs where installation_id=${installation.id} and generation=${installation.generation}
          and trigger_kind in ('uninstall','disconnect') and status<>'succeeded' limit 1`;
        if (!pending) {
          await tx`update extension_installations set state='uninstalled',last_error=null,updated_at=now() where id=${installation.id}`;
          await tx`select retainer_finish_extension_cleanup(${installation.id}::uuid)`;
        }
      }
      const [failed] =
        await tx`select 1 from extension_jobs where connection_id=${job.connection_id} and connection_generation=${job.connection_generation} and status='failed' limit 1`;
      if (!failed)
        await tx`update extension_connections set health='ok',last_error=null where id=${job.connection_id}`;
      return false;
    }
    if (status === 'failed') {
      await failInstallation(
        tx,
        installation,
        job,
        code ?? (job.trigger_kind === 'install' ? 'setup_failed' : 'run_failed'),
      );
      return false;
    }
    if (!['install', 'uninstall'].includes(job.trigger_kind)) {
      if (status === 'succeeded') {
        const [failed] =
          await tx`select id from extension_jobs where installation_id=${installation.id} and generation=${installation.generation} and status='failed' limit 1`;
        if (!failed)
          await tx`update extension_installations set connection_health='ok',last_error=null where id=${installation.id}`;
      }
      return false;
    }
    if (status !== 'succeeded') return false;
    const [pending] =
      await tx`select id from extension_jobs where installation_id=${installation.id}
      and generation=${installation.generation} and trigger_kind=${job.trigger_kind} and status<>'succeeded' limit 1`;
    if (pending) return false;
    if (job.trigger_kind === 'install') {
      if (
        this.manifest(installation).source &&
        this.manifest(installation).connection === 'workspace'
      ) {
        const [verified] =
          await tx`select 1 from source_bindings where installation_id=${installation.id} and generation=${installation.generation}`;
        if (!verified) {
          await tx`update extension_installations set state=${installation.setup_kind === 'upgrade' ? 'disabled' : 'setup_failed'},connection_health='needs_reconnect',last_error='source_verification_required' where id=${installation.id}`;
          await tx`update extension_jobs set status='failed',code='source_verification_required' where id=${job.id}`;
          return false;
        }
      }
      const hooks = this.manifest(installation).webhooks ?? [];
      if (hooks.length) {
        const bindings = await tx<
          { route: string; secret_name: string; state: string; account_matches: boolean }[]
        >`select b.route,b.secret_name,b.state,s.account_id is not null as account_matches from webhook_bindings b
          left join source_bindings s on s.installation_id=b.installation_id and s.generation=b.generation and s.account_id=b.source_account_id
          where b.installation_id=${installation.id} and b.generation=${installation.generation} and b.release_digest=${installation.release_digest} and b.state<>'retired'`;
        const [ready] = await tx<
          { names: string[] }[]
        >`select retainer_extension_secret_names(${installation.id}::uuid) as names`;
        if (
          hooks
            .filter(
              (hook) => !hook.optional || bindings.some((binding) => binding.route === hook.route),
            )
            .some(
              (hook) =>
                !bindings.some(
                  (binding) =>
                    binding.route === hook.route &&
                    binding.secret_name === hook.secretSetting &&
                    binding.state === 'active' &&
                    binding.account_matches,
                ) || !ready?.names.includes(hook.secretSetting),
            )
        ) {
          await tx`update extension_installations set state=${installation.setup_kind === 'upgrade' ? 'disabled' : 'setup_failed'},connection_health='needs_reconnect',last_error='webhook_binding_required' where id=${installation.id}`;
          await tx`update extension_jobs set status='failed',code='webhook_binding_required' where id=${job.id}`;
          return false;
        }
      }
      if (this.manifest(installation).functions.some((fn) => fn.trigger.kind === 'change'))
        await tx`insert into change_dispatch(workspace_id,installation_id,generation,position)
          values(${installation.workspace_id},${installation.id},${installation.generation},coalesce((select position from change_counters where workspace_id=${installation.workspace_id}),0))
          on conflict(workspace_id,installation_id) do update set generation=excluded.generation,position=excluded.position,blocked_cycles=0`;
      await tx`update extension_installations set state='active',connection_health='ok',last_error=null,activated_at=clock_timestamp(),updated_at=now() where id=${installation.id}`;
      if (this.manifest(installation).connection === 'member') {
        const hook =
          this.manifest(installation).functions.find((f) => f.trigger.kind === 'disconnect')
            ?.universalId ?? null;
        const connections =
          await tx`update extension_connections set state='connecting',health='ok',last_error=null,disconnect_function_id=${hook}
          where installation_id=${installation.id} and state<>'disconnected' returning id`;
        for (const c of connections)
          await this.enqueueConnectionLifecycle(
            tx,
            installation.workspace_id,
            installation.id,
            c.id,
            lifecycleInputSchema.parse(job.input).previousVersion ?? null,
          );
      }
      return true;
    }
    const [memberCleanup] =
      await tx`select 1 from extension_jobs where installation_id=${installation.id} and generation=${installation.generation}
      and trigger_kind='disconnect' and status<>'succeeded' limit 1`;
    if (memberCleanup) return false;
    await tx`update extension_installations set state='uninstalled',last_error=null,updated_at=now() where id=${installation.id}`;
    await tx`select retainer_finish_extension_cleanup(${installation.id}::uuid)`;
    return false;
  }
  async complete(
    lease: Lease,
    result: { status: 'succeeded' | 'retry' | 'failed'; code?: string; retryAfterSeconds?: number },
  ) {
    z.strictObject({
      status: z.enum(['succeeded', 'retry', 'failed']),
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,79}$/)
        .optional(),
      retryAfterSeconds: z.number().int().min(0).max(3600).optional(),
    }).parse(result);
    return this.withLease(
      lease,
      async (tx, installation, job) => {
        const status =
          result.status === 'retry'
            ? job.cycle_attempt >= 10
              ? 'failed'
              : 'queued'
            : result.status;
        const code =
          job.cycle_attempt >= 10 && result.status === 'retry'
            ? 'retry_exhausted'
            : (result.code ?? null);
        const delay = Math.min(
          3600,
          Math.max(
            result.retryAfterSeconds ?? 0,
            30 * 2 ** (job.cycle_attempt - 1) * (0.5 + Math.random()),
          ),
        );
        await tx`update extension_jobs set status=${status},code=${code},lease_owner=null,lease_until=null,
        available_at=now()+${delay}*interval '1 second',updated_at=now() where id=${job.id}`;
        await tx`update extension_attempts set status=${result.status},code=${code},finished_at=now() where job_id=${job.id} and attempt=${job.attempt}`;
        const activated = await this.finishLifecycle(tx, installation, job, status, code);
        return { status, activated };
      },
      true,
    );
  }
  /**
   * Hands a run back after a graceful executor shutdown. The first few releases of a job do not
   * consume an attempt; after that it counts, so repeated restarts cannot run a job forever.
   */
  async release(lease: Lease) {
    return this.withLease(
      lease,
      async (tx, _installation, job) => {
        const [released] = await tx<
          { count: number }[]
        >`select count(*)::int as count from extension_attempts
          where job_id=${job.id} and status='cancelled' and code='executor_stopped'`;
        const refund = (released?.count ?? 0) < FREE_RELEASES ? 1 : 0;
        await tx`update extension_jobs set status='queued',code='executor_stopped',lease_owner=null,lease_until=null,run_until=null,
          cycle_attempt=greatest(cycle_attempt-${refund},0),available_at=now(),updated_at=now() where id=${job.id}`;
        await tx`update extension_attempts set status='cancelled',code='executor_stopped',finished_at=now() where job_id=${job.id} and attempt=${job.attempt}`;
      },
      true,
    );
  }
  async checkpoint(
    lease: Lease,
    input: {
      children: Enqueue[];
      scanComplete?: { scanId: string; through: string };
      kv?: { key: string; expectedRevision: number | null; value: unknown };
    },
  ) {
    if (input.children.length > 1000)
      throw new AppError(413, 'quota_exceeded', 'checkpoint has too many child jobs');
    return this.withLease(lease, async (tx, installation, job) => {
      if (['uninstall', 'disconnect'].includes(job.trigger_kind))
        throw new AppError(403, 'forbidden', 'cleanup runs cannot modify runtime state');
      const ids = [];
      for (const child of input.children)
        ids.push(
          await this.insert(
            tx,
            installation,
            child,
            job.cause,
            'job',
            ['install', 'connect'].includes(job.trigger_kind),
            job.cause_depth ?? job.cause.length,
          ),
        );
      let revision: number | undefined;
      if (input.kv) {
        const kv = input.kv;
        if (!kv.key || kv.key.length > 200)
          throw new AppError(422, 'invalid_input', 'invalid KV key');
        const [previous] = await tx<
          { revision: number; bytes: number }[]
        >`select revision,octet_length(value::text) as bytes from extension_kv where installation_id=${installation.id} and connection_id is not distinct from ${installation.connection_id ?? null}::uuid and key=${kv.key}`;
        if ((previous?.revision ?? null) !== kv.expectedRevision)
          throw conflict('revision_conflict', 'KV revision changed');
        const [sizes] = await tx<
          { bytes: number; total: number }[]
        >`select octet_length(${tx.json(jsonValue(kv.value))}::jsonb::text) as bytes,
          (select coalesce(sum(octet_length(value::text)),0)::int from extension_kv where installation_id=${installation.id} and connection_id is not distinct from ${installation.connection_id ?? null}::uuid) as total`;
        if (
          !sizes ||
          sizes.bytes > 65536 ||
          sizes.total - (previous?.bytes ?? 0) + sizes.bytes > this.limits.kvBytes
        )
          throw new AppError(429, 'quota_exceeded', 'installation KV quota exceeded');
        revision = (previous?.revision ?? 0) + 1;
        await tx`insert into extension_kv(workspace_id,installation_id,connection_id,key,value,revision)
          values(${lease.workspaceId},${installation.id},${installation.connection_id ?? null},${kv.key},${tx.json(jsonValue(kv.value))},${revision})
          on conflict(workspace_id,installation_id,connection_id,key) do update set value=excluded.value,revision=excluded.revision`;
      }
      if (input.scanComplete) {
        const scan = sourceScanSchema.safeParse(job.input);
        if (
          !this.manifest(installation).source?.scanFunctionIds?.includes(job.function_id) ||
          job.trigger_kind !== 'job' ||
          !scan.success ||
          scan.data.scanId !== input.scanComplete.scanId ||
          Date.parse(scan.data.through) !== Date.parse(input.scanComplete.through)
        )
          throw new AppError(403, 'forbidden', 'only the bound scan job may complete enumeration');
        const [completed] =
          await tx`update source_sync_state set completed_at=coalesce(completed_at,clock_timestamp()),
          last_successful_scan_at=greatest(last_successful_scan_at,upper_bound) where installation_id=${installation.id} and connection_id is not distinct from ${installation.connection_id ?? null}::uuid and generation=${installation.generation}
          and scan_id=${scan.data.scanId} and mode=${scan.data.mode}
          and lower_bound=${scan.data.from}::timestamptz and upper_bound=${scan.data.through}::timestamptz returning scan_id`;
        if (!completed) throw conflict('scan_conflict', 'source scan changed before completion');
      }
      return { ids, revision };
    });
  }

  async scheduleTick(workspace: string, installationId: string) {
    return inWorkspace(this.sql, workspace, async (tx) => {
      await lockSchemaShared(tx, workspace);
      const installation = await this.installation(tx, workspace, installationId);
      if (installation.state !== 'active') return { scheduled: 0 };
      const manifest = this.runnableRelease(installation);
      if (!manifest) return { scheduled: 0 };
      const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
      if (!clock) throw new Error('database clock unavailable');
      const members =
        manifest.connection === 'member'
          ? await tx`select id from extension_connections where installation_id=${installationId} and state='active' order by id`
          : [];
      const scopes: Installation[] =
        manifest.connection === 'member'
          ? await Promise.all(members.map((c) => this.connection(tx, installation, c.id)))
          : [installation];
      if (!scopes.length) {
        await tx`insert into extension_schedules(workspace_id,installation_id,function_id,next_due_at)
          values(${workspace},${installationId},${SYSTEM_LIFECYCLE_FUNCTION_ID},'infinity'::timestamptz)
          on conflict(workspace_id,installation_id,connection_id,function_id) do nothing`;
      }
      let scheduled = 0;
      for (const scope of scopes) {
        for (const fn of manifest.functions) {
          if (fn.trigger.kind !== 'schedule') continue;
          await tx`insert into extension_schedules(workspace_id,installation_id,connection_id,function_id,next_due_at)
            values(${workspace},${installationId},${scope.connection_id ?? null},${fn.universalId},${nextOccurrence(fn.trigger.cron, scope.activated_at ?? clock.now)})
            on conflict(workspace_id,installation_id,connection_id,function_id) do nothing`;
        }
        if (!manifest.functions.some((f) => f.trigger.kind === 'schedule'))
          await tx`insert into extension_schedules(workspace_id,installation_id,connection_id,function_id,next_due_at)
            values(${workspace},${installationId},${scope.connection_id ?? null},${SYSTEM_LIFECYCLE_FUNCTION_ID},'infinity'::timestamptz)
            on conflict(workspace_id,installation_id,connection_id,function_id) do nothing`;
        const due = await tx<
          { function_id: string; next_due_at: Date }[]
        >`select function_id,next_due_at from extension_schedules
          where installation_id=${installationId} and connection_id is not distinct from ${scope.connection_id ?? null}::uuid and next_due_at<=${clock.now} for update skip locked`;
        for (const row of due) {
          const fn = manifest.functions.find((f) => f.universalId === row.function_id);
          if (fn?.trigger.kind !== 'schedule') continue;
          const occurrence = row.next_due_at.toISOString();
          await this.insert(
            tx,
            scope,
            {
              functionId: fn.universalId,
              input: { scheduledAt: occurrence },
              dedupeKey: `schedule:${fn.universalId}:${occurrence}`,
            },
            [],
            'schedule',
          );
          await tx`update extension_schedules set last_occurrence=${row.next_due_at},next_due_at=${nextOccurrence(fn.trigger.cron, clock.now)}
            where installation_id=${installationId} and connection_id is not distinct from ${scope.connection_id ?? null}::uuid and function_id=${row.function_id}`;
          scheduled++;
        }
      }
      return { scheduled };
    });
  }
  async retry(caller: Caller, installationId: string, jobId: string, key: string) {
    if (!canApproveDestructive(caller.actor, caller.scopes))
      throw new AppError(403, 'forbidden', 'only a human admin can retry a run');
    if (!key || key.length > 200)
      throw new AppError(400, 'invalid_request', 'Idempotency-Key must contain 1–200 characters');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      let installation = await this.installation(tx, caller.workspaceId, installationId, false);
      const hash = requestHash({
        operation: 'retry_run',
        jobId,
        installationId,
        actor: caller.actor,
      });
      const [receipt] = await tx<
        { request_hash: string; generation: number; response: { id: string; status: string } }[]
      >`select * from extension_receipts where key=${key}`;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw conflict('idempotency_conflict', 'retry key was used for another request');
        if (receipt.generation !== installation.generation) throw unavailable();
        return receipt.response;
      }
      const [job] = await tx<
        Job[]
      >`select * from extension_jobs where id=${jobId} and installation_id=${installationId} for update`;
      if (!job) throw notFound('extension run');
      installation = await this.connection(tx, installation, job.connection_id);
      if (
        job.connection_id &&
        (job.trigger_kind === 'connect' ||
          job.connection_generation !== installation.connection_generation)
      )
        throw conflict('connection_required', 'reconnect this member connection to restart setup');
      if (
        job.generation !== installation.generation ||
        job.release_digest !== installation.release_digest
      )
        throw unavailable();
      if (job.status !== 'failed')
        throw conflict('run_not_failed', 'only failed runs can be retried');
      const fn = this.manifest(installation).functions.find(
        (f) => f.universalId === job.function_id,
      );
      const setupRetry =
        job.trigger_kind === 'install' &&
        (installation.state === 'setup_failed' ||
          (installation.state === 'disabled' &&
            !!installation.last_error &&
            installation.setup_kind === 'upgrade'));
      if (!runnable(installation, job.trigger_kind) && !setupRetry) throw unavailable();
      const system =
        job.function_id === SYSTEM_LIFECYCLE_FUNCTION_ID &&
        ['install', 'uninstall'].includes(job.trigger_kind);
      if (!system && (!fn || fn.trigger.kind !== job.trigger_kind))
        throw conflict('incompatible_runtime', 'job function is unavailable');
      if (job.trigger_kind === 'install' || job.trigger_kind === 'uninstall')
        validateLifecycleInput(job.trigger_kind, job.input);
      else if (fn) validateInput(fn.inputSchema, job.input);
      if (setupRetry)
        await tx`update extension_installations set state=${installation.setup_kind === 'upgrade' ? 'upgrading' : 'installing'},last_error=null where id=${installationId}`;
      await tx`update extension_jobs set status='queued',code=null,cycle_attempt=0,fence=fence+1,
        lease_owner=null,lease_until=null,run_until=null,available_at=clock_timestamp(),expires_at=clock_timestamp()+interval '24 hours',updated_at=now() where id=${jobId}`;
      const response = { id: jobId, status: 'queued' };
      await tx`insert into extension_receipts(workspace_id,key,request_hash,installation_id,generation,response)
        values(${caller.workspaceId},${key},${hash},${installationId},${installation.generation},${tx.json(response)})`;
      return response;
    });
  }
  async getKv(lease: Lease, key: string) {
    return this.withLease(lease, async (tx, _installation, job) => {
      if (['uninstall', 'disconnect'].includes(job.trigger_kind))
        throw new AppError(403, 'forbidden', 'cleanup runs cannot read runtime state');
      const [row] = await tx<
        { value: unknown; revision: number }[]
      >`select value,revision from extension_kv where installation_id=${lease.installationId} and connection_id is not distinct from ${lease.connectionId ?? null}::uuid and key=${key}`;
      return row ?? null;
    });
  }
}
