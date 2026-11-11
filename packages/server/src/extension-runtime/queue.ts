import type { ExtensionManifest, InputSchema } from '@retainer/extension';
import { nextOccurrence, SYSTEM_LIFECYCLE_FUNCTION_ID } from '@retainer/extension';
import { sourceScanSchema } from '@retainer/shared';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import { retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockPrivacyShared, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { getSchema } from '../schema/compiled.js';
import { stableJson } from '../stable-json.js';
import { failInstallation } from './lifecycle.js';
import { cancelRuns, lockExtension, lockQueue } from './locks.js';

export type Lease = {
  workspaceId: string;
  installationId: string;
  jobId: string;
  owner: string;
  fence: string;
};
export type Enqueue = { functionId: string; input: unknown; dedupeKey: string };
export type ClaimedJob = Lease & {
  triggerKind: string;
  system: boolean;
  registrationId: string;
  scopes: ('read' | 'write')[];
  generation: number;
  releaseDigest: string;
  functionId: string;
  input: unknown;
  attempt: number;
  deadline: Date;
};
type Installation = {
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
};
export type ResolveRelease = (
  registrationId: string,
  version: string,
  digest: string,
) => ExtensionManifest;
const unavailable = () =>
  new AppError(409, 'installation_disabled', 'installation is disabled or its generation changed');
const runnable = (i: Installation, kind: string) =>
  kind === 'install'
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

/** Durable queue. No method executes provider code or accepts a workspace-supplied executable. */
export class ExtensionQueue {
  constructor(
    readonly sql: Sql,
    private readonly resolve: ResolveRelease,
    private readonly limits = { queued: 10000, kvBytes: 1048576 },
  ) {}

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
  private manifest(installation: Installation) {
    const manifest = this.resolve(
      installation.registration_id,
      installation.version,
      installation.release_digest,
    );
    if (
      manifest.universalId !== installation.registration_id ||
      manifest.version !== installation.version
    )
      throw new AppError(
        409,
        'incompatible_runtime',
        'registered release differs from installation',
      );
    return manifest;
  }
  private async insert(
    tx: Tx,
    installation: Installation,
    input: Enqueue,
    cause: string[],
    kind: 'job' | 'schedule' | 'install' | 'uninstall' | 'change' = 'job',
    setupChild = false,
  ) {
    if (
      !runnable(installation, kind) &&
      !(setupChild && kind === 'job' && ['installing', 'upgrading'].includes(installation.state))
    )
      throw unavailable();
    if (!input.dedupeKey || input.dedupeKey.length > 500)
      throw new AppError(422, 'invalid_input', 'dedupe key must contain 1–500 characters');
    const manifest = this.manifest(installation);
    const fn = manifest.functions.find((f) => f.universalId === input.functionId);
    const system =
      input.functionId === SYSTEM_LIFECYCLE_FUNCTION_ID && ['install', 'uninstall'].includes(kind);
    if (!system && fn?.trigger.kind !== kind)
      throw new AppError(422, 'invalid_input', 'only registered job functions can be enqueued');
    if (fn) validateInput(fn.inputSchema, input.input);
    let sourceItemId: string | null = null;
    if (manifest.source?.syncFunctionIds.includes(input.functionId)) {
      sourceItemId = z.uuid().parse((input.input as { sourceItemId?: unknown }).sourceItemId);
      const [item] =
        await tx`select s.id from source_items s join source_bindings b on b.account_id=s.account_id
        where s.id=${sourceItemId} and s.state not in ('erased','retracted','deleted') and b.installation_id=${installation.id} and b.generation=${installation.generation}`;
      if (!item) throw notFound('source item');
    }
    if (Buffer.byteLength(stableJson(input.input)) > 65536)
      throw new AppError(413, 'quota_exceeded', 'job input exceeds 64 KiB');
    const hash = requestHash({ functionId: input.functionId, input: input.input, cause });
    const [existing] = await tx<
      Job[]
    >`select * from extension_jobs where installation_id=${installation.id}
      and generation=${installation.generation} and dedupe_key=${input.dedupeKey}`;
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
      (workspace_id,installation_id,generation,release_digest,function_id,input,input_hash,dedupe_key,cause,trigger_kind,source_item_id)
      values (${installation.workspace_id},${installation.id},${installation.generation},${installation.release_digest},
        ${input.functionId},${tx.json(jsonValue(input.input))},${hash},${input.dedupeKey},${tx.json(cause)},${kind},${sourceItemId}) returning id`;
    if (!job) throw new Error('job insert returned no row');
    return job.id;
  }
  /** Trusted verified ingress only; receipt and source reservation share the caller's transaction. */
  async enqueueWebhook(tx: Tx, workspace: string, id: string, generation: number, input: Enqueue) {
    const installation = await this.installation(tx, workspace, id);
    if (installation.generation !== generation) throw unavailable();
    if (!this.manifest(installation).source?.syncFunctionIds.includes(input.functionId))
      throw new AppError(403, 'forbidden', 'webhook target must be a pinned source sync function');
    return { id: await this.insert(tx, installation, input, []) };
  }
  /** Trusted control transaction only. Runtime payloads never select lifecycle kinds. */
  async enqueueLifecycle(tx: Tx, workspace: string, id: string, kind: 'install' | 'uninstall') {
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
        { functionId, input: {}, dedupeKey: `lifecycle:${kind}:${functionId}` },
        [],
        kind,
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
        const manifest = this.manifest(installation),
          schema = await getSchema(tx, workspace);
        const handlers = manifest.functions.filter((fn) => fn.trigger.kind === 'change');
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
        const rows = await tx<
          {
            position: string;
            record_id: string;
            object_type_id: string;
            operation: string;
            field_keys: string[];
            cause: string[];
            origin_installation_id: string | null;
            related_record_ids: string[];
            merged_into_id: string | null;
          }[]
        >`
        select position::text,record_id,object_type_id,operation,field_keys,cause,origin_installation_id,related_record_ids,merged_into_id from record_changes
        where position>${checkpoint.position}::bigint order by position limit ${limit}`;
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
          cycles = 0;
        for (const row of rows)
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
            const direct =
              row.object_type_id === object.id &&
              (!fn.trigger.fieldIds.length ||
                !['update', 'review'].includes(row.operation) ||
                keys.some((key) => row.field_keys.includes(key as string)));
            const relationChanged = row.field_keys.some((key) =>
              schema.objectsById
                .get(row.object_type_id)
                ?.activeFields.some((field) => field.key === key && field.type === 'relation'),
            );
            const linksAffected = !['update', 'review'].includes(row.operation) || relationChanged;
            const indirect =
              linksAffected &&
              [...row.related_record_ids, ...(row.merged_into_id ? [row.merged_into_id] : [])].some(
                (id) => relatedTypes.get(id) === object.id,
              );
            if (!direct && !indirect) continue;
            if (row.cause.includes(id) || row.cause.length >= 8) {
              blocked++;
              if (row.origin_installation_id !== id) cycles++;
              continue;
            }
            const changeJobId = await this.insert(
              tx,
              installation,
              {
                functionId: fn.universalId,
                input: { changePosition: row.position },
                dedupeKey: `change:${row.position}:${fn.universalId}`,
              },
              row.cause,
              'change',
            );
            await tx`update extension_jobs j set change_snapshot=(to_jsonb(c)-'workspace_id'-'created_at')||jsonb_build_object('position',c.position::text)
            from record_changes c where j.id=${changeJobId} and j.change_snapshot is null and c.workspace_id=${workspace} and c.position=${row.position}::bigint`;
            queued++;
          }
        const last = rows.at(-1);
        if (last)
          await tx`update change_dispatch set position=${last.position}::bigint,blocked_cycles=blocked_cycles+${blocked} where installation_id=${id}`;
        if (cycles)
          await tx`update extension_installations set last_error='trigger_cycle_blocked',connection_health='degraded' where id=${id}`;
        if (!cycles)
          await tx`update extension_installations set connection_health='ok',last_error=null where id=${id}
        and last_error in ('quota_exceeded','cursor_expired','schema_binding_conflict','dispatch_unavailable')
        and not exists(select 1 from extension_jobs where installation_id=${id} and generation=${installation.generation} and status='failed')`;
        return { queued, blocked };
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
    return discoverySql<
      { workspace_id: string; job_id: string }[]
    >`select * from retainer_extension_jobs_due(${limit})`;
  }
  async maintain(discoverySql: Sql) {
    const due = await discoverySql<{ workspace_id: string; installation_id: string }[]>`
      select * from retainer_extension_maintenance_due(1000)`;
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
          if (!expired) return;
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

  async claim(workspace: string, id: string, owner: string): Promise<ClaimedJob | null> {
    if (!owner || owner.length > 200) throw new Error('invalid lease owner');
    return inWorkspace(this.sql, workspace, async (tx) => {
      await lockSchemaShared(tx, workspace);
      const [candidate] = await tx<Job[]>`select * from extension_jobs where id=${id}`;
      if (!candidate) return null;
      const installation = await this.installation(tx, workspace, candidate.installation_id, false);
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
      if (!runnable(installation, job.trigger_kind)) return null;
      const fn = this.manifest(installation).functions.find(
        (f) => f.universalId === job.function_id,
      );
      const system =
        job.function_id === SYSTEM_LIFECYCLE_FUNCTION_ID &&
        ['install', 'uninstall'].includes(job.trigger_kind);
      if (!system && fn?.trigger.kind !== job.trigger_kind)
        throw new AppError(
          409,
          'incompatible_runtime',
          'job function is unavailable in pinned release',
        );
      const timeout = fn?.timeoutSeconds ?? 30;
      const [exhausted] =
        await tx`select 1 where ${job.expires_at}<=clock_timestamp() or ${job.cycle_attempt}>=10`;
      if (exhausted) {
        await tx`update extension_jobs set status='failed',code='retry_exhausted',lease_until=null where id=${id}`;
        await tx`update extension_attempts set status='failed',code='retry_exhausted',finished_at=now() where job_id=${id} and finished_at is null`;
        await this.finishLifecycle(tx, installation, job, 'failed', 'retry_exhausted');
        return null;
      }
      const [other] =
        await tx`select id from extension_jobs where installation_id=${installation.id} and status='running' and id<>${id}`;
      if (other) return null;
      const [slot] = await tx<
        { available: boolean }[]
      >`select retainer_extension_slot_available(${id}::uuid) as available`;
      if (!slot?.available) return null;
      // An old attempt remains visible even when its worker disappeared.
      await tx`update extension_attempts set status='expired',code='lease_expired',finished_at=now() where job_id=${id} and finished_at is null`;
      const [claimed] = await tx<
        Job[]
      >`update extension_jobs set status='running',lease_owner=${owner},
        fence=fence+1,lease_until=clock_timestamp()+least(60,${timeout})*interval '1 second',run_until=clock_timestamp()+${timeout}*interval '1 second',attempt=attempt+1,cycle_attempt=cycle_attempt+1,updated_at=now()
        where id=${id} returning *`;
      if (!claimed) throw new Error('claim returned no row');
      await tx`insert into extension_attempts(workspace_id,job_id,attempt,fence,status)
        values(${workspace},${id},${claimed.attempt},${claimed.fence},'running')`;
      return {
        workspaceId: workspace,
        installationId: installation.id,
        jobId: id,
        owner,
        fence: String(claimed.fence),
        triggerKind: claimed.trigger_kind,
        system,
        registrationId: installation.registration_id,
        scopes: installation.granted_scopes,
        generation: claimed.generation,
        releaseDigest: claimed.release_digest,
        functionId: claimed.function_id,
        input: claimed.input,
        attempt: claimed.attempt,
        deadline: claimed.run_until as Date,
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
      const installation = await this.installation(
        tx,
        lease.workspaceId,
        lease.installationId,
        !exclusive,
      );
      if (!['active', 'installing', 'upgrading', 'uninstalling'].includes(installation.state))
        throw unavailable();
      const [job] = await tx<
        Job[]
      >`select * from extension_jobs where id=${lease.jobId} and installation_id=${lease.installationId}
        and status='running' and lease_owner=${lease.owner} and fence=${lease.fence}::bigint
        and generation=${installation.generation} and release_digest=${installation.release_digest} and lease_until>clock_timestamp() and run_until>clock_timestamp() for update`;
      if (!job) throw expired();
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
      if (this.manifest(installation).source) {
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
      return true;
    }
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
      if (job.trigger_kind === 'uninstall')
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
            job.trigger_kind === 'install',
          ),
        );
      let revision: number | undefined;
      if (input.kv) {
        const kv = input.kv;
        if (!kv.key || kv.key.length > 200)
          throw new AppError(422, 'invalid_input', 'invalid KV key');
        const [previous] = await tx<
          { revision: number; bytes: number }[]
        >`select revision,octet_length(value::text) as bytes from extension_kv where installation_id=${installation.id} and key=${kv.key}`;
        if ((previous?.revision ?? null) !== kv.expectedRevision)
          throw conflict('revision_conflict', 'KV revision changed');
        const [sizes] = await tx<
          { bytes: number; total: number }[]
        >`select octet_length(${tx.json(jsonValue(kv.value))}::jsonb::text) as bytes,
          (select coalesce(sum(octet_length(value::text)),0)::int from extension_kv where installation_id=${installation.id}) as total`;
        if (
          !sizes ||
          sizes.bytes > 65536 ||
          sizes.total - (previous?.bytes ?? 0) + sizes.bytes > this.limits.kvBytes
        )
          throw new AppError(429, 'quota_exceeded', 'installation KV quota exceeded');
        revision = (previous?.revision ?? 0) + 1;
        await tx`insert into extension_kv(workspace_id,installation_id,key,value,revision)
          values(${lease.workspaceId},${installation.id},${kv.key},${tx.json(jsonValue(kv.value))},${revision})
          on conflict(workspace_id,installation_id,key) do update set value=excluded.value,revision=excluded.revision`;
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
          last_successful_scan_at=greatest(last_successful_scan_at,upper_bound) where installation_id=${installation.id} and generation=${installation.generation}
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
      const manifest = this.manifest(installation);
      const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
      if (!clock) throw new Error('database clock unavailable');
      for (const fn of manifest.functions) {
        if (fn.trigger.kind !== 'schedule') continue;
        await tx`insert into extension_schedules(workspace_id,installation_id,function_id,next_due_at)
          values(${workspace},${installationId},${fn.universalId},${nextOccurrence(fn.trigger.cron, installation.activated_at ?? clock.now)})
          on conflict(workspace_id,installation_id,function_id) do nothing`;
      }
      if (!manifest.functions.some((fn) => fn.trigger.kind === 'schedule')) {
        await tx`insert into extension_schedules(workspace_id,installation_id,function_id,next_due_at)
          values(${workspace},${installationId},${SYSTEM_LIFECYCLE_FUNCTION_ID},'infinity'::timestamptz)
          on conflict(workspace_id,installation_id,function_id) do nothing`;
      }
      const due = await tx<
        { function_id: string; next_due_at: Date }[]
      >`select function_id,next_due_at from extension_schedules
        where installation_id=${installationId} and next_due_at<=${clock.now} for update skip locked`;
      let scheduled = 0;
      for (const row of due) {
        const fn = manifest.functions.find((f) => f.universalId === row.function_id);
        if (fn?.trigger.kind !== 'schedule') continue;
        const occurrence = row.next_due_at.toISOString();
        await this.insert(
          tx,
          installation,
          {
            functionId: fn.universalId,
            input: { scheduledAt: occurrence },
            dedupeKey: `schedule:${fn.universalId}:${occurrence}`,
          },
          [],
          'schedule',
        );
        await tx`update extension_schedules set last_occurrence=${row.next_due_at},next_due_at=${nextOccurrence(fn.trigger.cron, clock.now)}
          where installation_id=${installationId} and function_id=${fn.universalId}`;
        scheduled++;
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
      const installation = await this.installation(tx, caller.workspaceId, installationId, false);
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
      if (fn?.trigger.kind !== job.trigger_kind)
        throw conflict('incompatible_runtime', 'job function is unavailable');
      validateInput(fn.inputSchema, job.input);
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
      if (job.trigger_kind === 'uninstall')
        throw new AppError(403, 'forbidden', 'cleanup runs cannot read runtime state');
      const [row] = await tx<
        { value: unknown; revision: number }[]
      >`select value,revision from extension_kv where installation_id=${lease.installationId} and key=${key}`;
      return row ?? null;
    });
  }
}
