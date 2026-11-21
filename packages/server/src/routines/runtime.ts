import {
  type PresentedRecord,
  ROUTINE_LIMITS,
  type RoutineEffectRequest,
  type RoutineEffectResponse,
  type RoutineManifest,
  type RoutineRecord,
  type RoutineRunContext,
  type ToolContract,
} from '@retainer/shared';
import { z } from 'zod';
import type { Caller, RoutineCaller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import type { ExtensionQueue } from '../extension-runtime/queue.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import { installedTools, sameContract, toolContract } from '../extensions/tools.js';
import type { Files } from '../files/service.js';
import { requestHash } from '../idempotency.js';
import { lockSource, logEvent, logEventInputSchema } from '../memory/events.js';
import { planRemember, rememberFact, rememberInputSchema } from '../memory/facts.js';
import { aggregateInputSchema, aggregateRecords } from '../records/aggregate.js';
import { queryInputSchema, queryRecords } from '../records/query.js';
import { getRecord } from '../records/read.js';
import { withRead, withWrite } from '../records/service.js';
import { prepareValues } from '../records/values.js';
import {
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordId,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';
import { getSchema } from '../schema/compiled.js';
import { stableJson } from '../stable-json.js';
import { capabilities, type RoutineConfig } from './capabilities.js';
import { contextTypeFor, fieldFor, mapFilter, objectFor } from './manifest.js';
import { pauseRoutine, queueRun, RUN_GRACE_SECONDS, useUp } from './runs.js';
import {
  insertProposal,
  proposeInputSchema,
  saveSource,
  staticCheck,
  workspaceZone,
} from './service.js';

export type RuntimeConfig = RoutineConfig & {
  tokens: RunTokens;
  /** Queues tool calls; without it no tool can be called. */
  queue?: ExtensionQueue | undefined;
  files?: Files | undefined;
  /** The model proxy's base URL routine code calls (§4.5). */
  modelOrigin?: string | undefined;
  /** The one model routines use; the operator sets it. */
  modelName: string;
  /** RETAINER_ROUTINE_MODEL_CALLS_PER_DAY. */
  modelCallsPerDay: number;
};

type RunState = {
  id: string;
  routine_id: string | null;
  version_id: string | null;
  source_id: string | null;
  mode: 'run' | 'test' | 'dry' | 'check' | 'build';
  trigger_kind: string;
  record_id: string | null;
  run_at: Date;
  started_at: Date | null;
  expires_at: Date | null;
  /** When this attempt ends: when the runner stops it, or the run's expiry if sooner. */
  deadline: Date | null;
  tool_contracts: Record<string, ToolContract> | null;
  attempt: number;
  cause: string[];
  cause_depth: number;
  initiator_user_id: string | null;
  initiated_by: { name?: string; id: string } | null;
  model_calls: number;
  input: (Record<string, unknown> & { triggerRecord?: RoutineRecord }) | null;
  manifest: RoutineManifest | null;
  code: string | null;
  types_fingerprint: string | null;
};

type ResultRow = {
  position: number;
  operation: string;
  args_hash: string;
  state: 'started' | 'done' | 'failed' | 'reported';
  result: unknown;
  code: string | null;
  tool_job_id: string | null;
};

const WRITE_OPERATIONS = ['record.create', 'record.update', 'events.log', 'remember'];

/** A record as routine code sees it: values by field key (§4.4). */
export function keyed(schema: CompiledSchema, record: PresentedRecord): RoutineRecord {
  const object = schema.objectsByName.get(record.object);
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record.fields)) {
    const field = object?.fieldsByName.get(name);
    values[field?.key ?? name] = value;
  }
  // The generated types say every field is present (`T | null`), so a value
  // never written reads as null and a relation with no members as [], not
  // as a missing property.
  for (const field of object?.activeFields ?? []) {
    if (Object.hasOwn(values, field.key)) continue;
    const many = field.type === 'relation' && field.settings.relationCardinality !== 'many_to_one';
    values[field.key] = many ? [] : null;
  }
  return {
    ...values,
    id: record.id,
    object: record.object,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.event
      ? {
          occurredAt: record.event.occurredAt,
          participants: record.event.participants.matched.map((p) => p.recordId),
          about: record.event.about,
        }
      : {}),
  };
}

/** Values by key (or name) as the write path takes them: by name. */
function named(object: CompiledObject, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(values)) {
    const field = fieldFor(object, ref);
    if (!field) throw new AppError(422, 'unknown_field', `${object.name} has no field "${ref}"`);
    out[field.name] = value;
  }
  return out;
}

const refused = (code: string, message: string) => new AppError(409, code, message);

/**
 * The routine runtime (§3.3, §6.2): what the routine runner and the code in
 * its sandbox call, with the run's token. Every effect is numbered by the
 * SDK and recorded under its run and position, so a retried run repeats
 * nothing; reads go by field key.
 */
export class RoutineRuntime {
  constructor(
    private readonly sql: Sql,
    private readonly config: RuntimeConfig,
  ) {}

  private binding(caller: Caller): RoutineCaller {
    if (!caller.routine) throw forbidden('only a routine run reaches the routine runtime');
    return caller.routine;
  }

  /** The run's row, its source and its version's fingerprint. */
  private async run(tx: Tx, runId: string, lock = false): Promise<RunState> {
    const [run] = await tx<RunState[]>`
      select r.id,r.routine_id,r.version_id,r.source_id,r.mode,r.trigger_kind,r.record_id,r.run_at,r.started_at,r.expires_at,
        least(r.expires_at,r.lease_until-${RUN_GRACE_SECONDS}*interval '1 second'
          -${ROUTINE_LIMITS.reportMarginMs}*interval '1 millisecond') as deadline,
        r.attempt,r.cause,r.cause_depth,r.initiator_user_id,r.initiated_by,r.model_calls,r.input,
        s.manifest,s.code,v.types_fingerprint,v.tool_contracts
      from routine_runs r left join routine_sources s on s.id=r.source_id
      left join routine_versions v on v.id=r.version_id
      where r.id=${runId} ${lock ? tx`for update of r` : tx``}`;
    if (!run) throw notFound('routine run');
    return run;
  }

  /** `GET /v1/routines/runtime/run`: everything the runner needs (§3.3). */
  async context(caller: Caller): Promise<RoutineRunContext> {
    const binding = this.binding(caller);
    return withRead(this.sql, caller, async (tx, schema) => {
      const run = await this.run(tx, binding.runId);
      const caps = await capabilities(tx, schema, this.config);
      const record = run.input?.triggerRecord;
      const pinned = run.types_fingerprint ?? (run.input?.typesFingerprint as string | undefined);
      return {
        run: {
          id: run.id,
          mode: run.mode,
          at: run.run_at.toISOString(),
          startedAt: (run.started_at ?? run.run_at).toISOString(),
          timezone: await workspaceZone(tx),
          dryRun: run.mode === 'dry',
          attempt: run.attempt,
        },
        trigger: {
          kind: (['record', 'schedule', 'manual', 'test', 'preview'].includes(run.trigger_kind)
            ? run.trigger_kind
            : 'test') as RoutineRunContext['trigger']['kind'],
          ...(run.trigger_kind === 'manual' && run.initiated_by
            ? { pressedBy: run.initiated_by.name ?? run.initiated_by.id }
            : {}),
        },
        ...(run.manifest ? { manifest: run.manifest } : {}),
        ...(run.code !== null ? { code: run.code } : {}),
        types: caps.types,
        ...(run.manifest ? { contextType: contextTypeFor(schema, run.manifest) } : {}),
        typesFingerprint: caps.typesFingerprint,
        // A preview's dry run may come before any validation, so it checks
        // its code in full, as a check run does (§5.2).
        check:
          run.mode === 'check' ||
          run.mode === 'dry' ||
          (pinned !== undefined && pinned !== caps.typesFingerprint),
        ...(record ? { record } : {}),
        ...(run.mode === 'build'
          ? {
              build: {
                description: String(run.input?.description ?? ''),
                routineId: (run.input?.routineId as string | null | undefined) ?? null,
              },
            }
          : {}),
        ...(this.config.modelOrigin && this.config.modelAvailable
          ? { model: { origin: this.config.modelOrigin } }
          : {}),
      };
    });
  }

  /** The builder checks its draft as fixed logic before it type-checks it (§5.2). */
  async buildCheck(caller: Caller, input: { manifest: unknown; code: string }) {
    const binding = this.binding(caller);
    if (binding.mode !== 'build') throw forbidden('only the builder checks drafts here');
    return withRead(this.sql, caller, async (tx, schema) => {
      const { manifest, problems, caps } = await staticCheck(
        tx,
        caller.workspaceId,
        this.config,
        input,
      );
      return {
        manifest,
        problems,
        typesFingerprint: caps.typesFingerprint,
        // The builder checks `main` against it, as a validation's check does;
        // a manifest with problems has no trigger to read it from.
        ...(problems.length ? {} : { contextType: contextTypeFor(schema, manifest) }),
      };
    });
  }

  /**
   * The builder's proposal (§5.1). The builder is first-party code in the
   * sandbox: it type-checked the code against these types itself, which is
   * recorded as the passed check a proposal needs. It cannot approve.
   */
  async buildPropose(caller: Caller, raw: unknown, typesFingerprint: string) {
    const binding = this.binding(caller);
    if (binding.mode !== 'build') throw forbidden('only the builder proposes here');
    const input = proposeInputSchema.parse(raw);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitCaller(tx, caller);
      const run = await this.run(tx, binding.runId, true);
      const { manifest, problems, caps } = await staticCheck(
        tx,
        caller.workspaceId,
        this.config,
        input,
      );
      if (problems.length)
        throw new AppError(422, 'invalid_routine', 'the routine does not pass its checks', {
          problems,
        });
      if (typesFingerprint !== caps.typesFingerprint)
        throw new AppError(409, 'check_required', 'the workspace changed while the builder worked');
      const sourceId = await saveSource(tx, caller.workspaceId, manifest, input.code);
      const checkId = await queueRun(tx, caller.workspaceId, {
        mode: 'check',
        triggerKind: 'check',
        sourceId,
        input: { typesFingerprint },
      });
      await tx`update routine_runs set status='succeeded',output=${tx.json({ valid: true, problems: [], typesFingerprint })},
        started_at=clock_timestamp(),finished_at=clock_timestamp() where id=${checkId}`;
      const requested = (run.input?.routineId as string | null | undefined) ?? undefined;
      const by = run.initiated_by?.name ?? run.initiated_by?.id;
      return insertProposal(
        tx,
        caller.workspaceId,
        {
          type: 'agent',
          id: 'retainer-builder',
          name: `Retainer's builder${by ? `, for ${by}` : ''}`,
        },
        { ...input, ...(requested ? { routineId: requested } : {}) },
        manifest,
        sourceId,
        caps,
      );
    });
  }

  /** Builder runs read the capabilities through the runtime, as their own agent would. */
  async capabilities(caller: Caller) {
    this.binding(caller);
    return withRead(this.sql, caller, async (tx, schema) => {
      const { installed: _installed, ...caps } = await capabilities(tx, schema, this.config);
      return caps;
    });
  }

  /** Reads by field key: get, query, aggregate and a file's text (§4.4). */
  async read(caller: Caller, operation: string, args: Record<string, unknown>) {
    await this.countRead(caller, operation);
    if (operation === 'files.text') return this.fileText(caller, z.uuid().parse(args.id));
    return withRead(this.sql, caller, async (tx, schema) => {
      const object = objectFor(schema, String(args.object ?? ''));
      if (!object) throw notFound(`object "${String(args.object)}"`);
      if (operation === 'record.get') {
        const id = z.uuid().parse(args.id);
        try {
          const record = await getRecord(tx, caller.workspaceId, schema, id);
          return record.object === object.name ? keyed(schema, record) : null;
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return null;
          throw error;
        }
      }
      const filter = args.filter
        ? mapFilter(object, args.filter as Record<string, unknown>, 'name')
        : undefined;
      if (operation === 'record.query') {
        const input = queryInputSchema.parse({
          ...(filter ? { filter } : {}),
          ...(args.sort
            ? {
                sort: (args.sort as { field: string; direction?: string }[]).map((s) => ({
                  ...s,
                  field: fieldFor(object, s.field)?.name ?? s.field,
                })),
              }
            : {}),
          limit: Math.min(Number(args.limit ?? 100), 100),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        });
        const page = await queryRecords(tx, caller.workspaceId, schema, object, input);
        const [count] = await tx<{ count: number }[]>`select ${page.records.length}::int as count`;
        return {
          records: page.records.map((record) => keyed(schema, record)),
          count: count?.count ?? page.records.length,
          nextCursor: page.nextCursor,
        };
      }
      if (operation === 'record.aggregate') {
        const input = aggregateInputSchema.parse({
          ...(filter ? { filter } : {}),
          aggregates: ((args.aggregates as { field: string; op: string }[]) ?? []).map((a) => ({
            ...a,
            field: fieldFor(object, a.field)?.name ?? a.field,
          })),
        });
        // Code names fields by key, so the result does too.
        const result = await aggregateRecords(tx, caller.workspaceId, schema, object, input);
        return {
          ...result,
          values: result.values.map((v) => ({
            ...v,
            field: object.fieldsByName.get(v.field)?.key ?? v.field,
          })),
        };
      }
      throw new AppError(400, 'invalid_request', `unknown read ${operation}`);
    });
  }

  /**
   * Counts one read against the per-operation cap (§4.6), atomically, in its
   * own transaction: concurrent reads cannot pass it together. Reads are not
   * replayed, so each attempt starts from zero.
   */
  private async countRead(caller: Caller, operation: string) {
    const { runId } = this.binding(caller);
    const cap = ROUTINE_LIMITS.callsPerOperation;
    await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      // The row lock first: admission's share lock, taken first, would deadlock
      // concurrent reads upgrading it.
      const [counted] = await tx`
        update routine_runs set read_calls=jsonb_set(read_calls,array[${operation}::text],
          to_jsonb(coalesce((read_calls->>${operation}::text)::int,0)+1))
        where id=${runId} and coalesce((read_calls->>${operation}::text)::int,0)<${cap} returning 1`;
      await admitCaller(tx, caller);
      if (!counted)
        throw new AppError(
          429,
          'operation_limit',
          `a run makes at most ${cap} calls of ${operation}`,
        );
    });
  }

  /** A file's text, up to 1 MiB, fetched by the server so the sandbox reaches only the API. */
  private async fileText(caller: Caller, id: string) {
    if (!this.config.files)
      throw new AppError(503, 'storage_unavailable', 'file storage is not configured');
    const transfer = await this.config.files.download(caller, id);
    const response = await fetch(transfer.url, { headers: transfer.headers, redirect: 'error' });
    if (!response.ok || !response.body)
      throw new AppError(503, 'storage_unavailable', 'the file could not be read');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes >= ROUTINE_LIMITS.fileTextBytes) break;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      Buffer.concat(chunks).subarray(0, ROUTINE_LIMITS.fileTextBytes),
    );
    return { text, truncated: bytes > ROUTINE_LIMITS.fileTextBytes };
  }

  /**
   * Finds the effect at this position (§6.2). A recorded one is returned, not
   * repeated, even when its arguments differ now; one recorded under another
   * operation means the code branched differently, and the run diverges.
   */
  private async recorded(
    tx: Tx,
    runId: string,
    request: RoutineEffectRequest,
    hash: string,
  ): Promise<RoutineEffectResponse | ResultRow | null> {
    const [existing] = await tx<ResultRow[]>`
      select position,operation,args_hash,state,result,code,tool_job_id from routine_run_results
      where run_id=${runId} and position=${request.position}`;
    if (!existing) {
      const [last] = await tx<{ max: number | null }[]>`
        select max(position) as max from routine_run_results where run_id=${runId}`;
      if (request.position !== (last?.max ?? 0) + 1)
        throw new AppError(409, 'run_diverged', 'effects are numbered one after another');
      const [count] = await tx<{ count: number }[]>`
        select count(*)::int as count from routine_run_results where run_id=${runId} and operation=${request.operation}`;
      if ((count?.count ?? 0) >= ROUTINE_LIMITS.callsPerOperation)
        throw new AppError(
          429,
          'operation_limit',
          `a run makes at most ${ROUTINE_LIMITS.callsPerOperation} calls of ${request.operation}`,
        );
      return null;
    }
    if (existing.operation !== request.operation || existing.args_hash !== hash)
      throw new AppError(409, 'run_diverged', 'the effect no longer matches its recorded call');
    if (existing.state === 'done')
      return {
        state: 'done',
        result: existing.result,
        replayed: true,
      };
    if (existing.state === 'reported') return { state: 'reported', stop: existing.code === 'stop' };
    if (existing.state === 'failed')
      throw new AppError(422, existing.code ?? 'effect_failed', 'this call failed');
    return existing;
  }

  private async record(
    tx: Tx,
    workspace: string,
    runId: string,
    request: RoutineEffectRequest,
    hash: string,
    row: {
      state: ResultRow['state'];
      result?: unknown;
      code?: string | null;
      toolJobId?: string | null;
      recordId?: string | null;
    },
  ) {
    await tx`insert into routine_run_results(workspace_id,run_id,position,operation,args_hash,state,result,code,tool_job_id,record_id)
      values(${workspace},${runId},${request.position},${request.operation},${hash},${row.state},
        ${row.result === undefined ? null : tx.json(jsonValue(row.result))},${row.code ?? null},
        ${row.toolJobId ?? null},${row.recordId ?? null})
      on conflict(run_id,position) do update set state=excluded.state,result=excluded.result,code=excluded.code,
        tool_job_id=coalesce(excluded.tool_job_id,routine_run_results.tool_job_id),
        record_id=coalesce(excluded.record_id,routine_run_results.record_id),updated_at=clock_timestamp()`;
  }

  /** A `oncePerRecord` run's first write or tool call uses its record up (§4.2). */
  private async useRecord(tx: Tx, workspace: string, run: RunState) {
    if (run.mode !== 'run' || !run.record_id || !run.routine_id) return;
    if (!(run.manifest?.when as { oncePerRecord?: boolean } | undefined)?.oncePerRecord) return;
    const id = await resolveRecordId(tx, workspace, run.record_id).catch(
      () => run.record_id as string,
    );
    if (!(await useUp(tx, workspace, run.routine_id, id, run.id)))
      throw refused('record_used_up', 'the routine already acted on this record');
  }

  /** `POST /v1/routines/runtime/effects`: one numbered effect (§6.2). */
  async effect(caller: Caller, request: RoutineEffectRequest): Promise<RoutineEffectResponse> {
    try {
      return await this.numbered(caller, request);
    } catch (thrown) {
      const error =
        thrown instanceof z.ZodError
          ? new AppError(400, 'invalid_request', 'the call does not match the expected shape', {
              issues: thrown.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            })
          : thrown;
      // A refused call is the code's to catch, so it keeps its position: it
      // is recorded as failed, and a retry gets the same error. Transient
      // refusals (a 429, or a server error) are not recorded.
      if (
        error instanceof AppError &&
        error.code !== 'run_diverged' &&
        ((error.status >= 400 && error.status < 500 && error.status !== 429) ||
          error.code === 'operation_limit')
      )
        await this.recordRefusal(caller, request, error.code).catch(() => {});
      // A changed tool pauses the routine (§5.3), in a transaction of its own.
      if (error instanceof AppError && error.code === 'tool_changed') {
        const { runId, fence } = this.binding(caller);
        await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
          const [row] = await tx<
            { routine_id: string | null; version_id: string | null; mode: string }[]
          >`
            select routine_id,version_id,mode from routine_runs
            where id=${runId} and fence=${fence}::bigint and status='running'`;
          if (row?.routine_id && row.mode === 'run')
            await pauseRoutine(
              tx,
              row.routine_id,
              'needs_attention',
              'tool_changed',
              row.version_id,
            );
        }).catch(() => {});
      }
      // The refusal rolls its transaction back; the run ends in one of its own.
      if (error instanceof AppError && error.code === 'run_diverged') {
        const { runId, fence } = this.binding(caller);
        await inWorkspace(
          this.sql,
          caller.workspaceId,
          (tx) =>
            tx`with stopped as (
              update routine_runs set status='diverged',code='run_diverged',finished_at=clock_timestamp(),
                lease_owner=null,lease_until=null,input=nullif(input-'triggerRecord','{}'::jsonb)
              where id=${runId} and fence=${fence}::bigint and status='running'
              returning id
            )
            update routine_run_results x set differs=true from stopped where x.run_id=stopped.id
              and x.position=${request.position}`,
        );
      }
      throw error;
    }
  }

  /** Records a refused effect at its position, if the run still holds it and it is the next one. */
  private async recordRefusal(caller: Caller, request: RoutineEffectRequest, code: string) {
    const { runId } = this.binding(caller);
    await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await admitCaller(tx, caller);
      const run = await this.run(tx, runId, true);
      const [last] = await tx<{ max: number | null; taken: boolean | null }[]>`
        select max(position) as max,bool_or(position=${request.position}) as taken
        from routine_run_results where run_id=${run.id}`;
      if (last?.taken || request.position !== (last?.max ?? 0) + 1) return;
      await this.record(tx, caller.workspaceId, run.id, request, requestHash(request.args), {
        state: 'failed',
        code,
      });
    });
  }

  private async numbered(
    caller: Caller,
    request: RoutineEffectRequest,
  ): Promise<RoutineEffectResponse> {
    const binding = this.binding(caller);
    const hash = requestHash(request.args);
    if (Buffer.byteLength(stableJson(request.args)) > ROUTINE_LIMITS.resultBytes)
      throw new AppError(413, 'quota_exceeded', "an effect's arguments exceed 64 KiB");
    const reporting =
      ['dry', 'check', 'build'].includes(binding.mode) && request.operation !== 'ai.generate';
    if (WRITE_OPERATIONS.includes(request.operation) && !reporting)
      return this.write(caller, binding, request, hash);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitCaller(tx, caller);
      const run = await this.run(tx, binding.runId, true);
      const found = await this.recorded(tx, run.id, request, hash);
      if (found && 'state' in found && !('position' in found)) return found;
      const started = found as ResultRow | null;
      if (reporting) {
        // A dry run lists what the code tried and makes none of it (§5.1). A
        // tool call ends that record's dry run: what follows may depend on it.
        const stop = request.operation === 'tool';
        await this.record(tx, caller.workspaceId, run.id, request, hash, {
          state: 'reported',
          result: request.args,
          code: stop ? 'stop' : null,
        });
        return { state: 'reported', stop };
      }
      if (request.operation === 'tool')
        return this.tool(tx, caller, binding, run, request, hash, started);
      if (request.operation === 'ai.generate')
        return this.model(tx, caller, run, request, hash, started);
      throw new AppError(400, 'invalid_request', `unknown effect ${request.operation}`);
    });
  }

  /**
   * A write to Retainer, recorded in its own transaction (§6.2): the
   * database guarantees it happens once. When the run was triggered by an
   * event, the write cites it unless the code names another (§4.4).
   */
  private async write(
    caller: Caller,
    binding: RoutineCaller,
    request: RoutineEffectRequest,
    hash: string,
  ): Promise<RoutineEffectResponse> {
    const writer: Caller = { ...caller, routine: { ...binding, effect: true } };
    return withWrite(this.sql, writer, async (tx, context) => {
      const run = await this.run(tx, binding.runId, true);
      const found = await this.recorded(tx, run.id, request, hash);
      if (found && 'state' in found && !('position' in found)) return found;
      await this.useRecord(tx, caller.workspaceId, run);
      const { result, recordId } = await this.perform(tx, context, run, request);
      await this.record(tx, caller.workspaceId, run.id, request, hash, {
        state: 'done',
        result,
        recordId,
      });
      return { state: 'done', result, replayed: false };
    });
  }

  private async defaultSource(tx: Tx, context: WriteContext, run: RunState, source: unknown) {
    if (typeof source === 'string') return source;
    if (!run.record_id) return undefined;
    const [row] = await tx<{ object_type_id: string }[]>`
      select object_type_id from records where id=${run.record_id}`;
    return row && context.schema.objectsById.get(row.object_type_id)?.isEvent
      ? run.record_id
      : undefined;
  }

  private async perform(
    tx: Tx,
    context: WriteContext,
    run: RunState,
    request: RoutineEffectRequest,
  ) {
    const args = request.args;
    const { schema, workspaceId } = context;
    if (request.operation === 'record.create' || request.operation === 'record.update') {
      const object = objectFor(schema, String(args.object ?? ''));
      if (!object) throw notFound(`object "${String(args.object)}"`);
      const values = (args.values ?? {}) as Record<string, unknown>;
      // The citation comes in the call's options, apart from the values, so a
      // field keyed `source` is written like any other.
      const sourceId = await this.defaultSource(tx, context, run, args.source);
      const cited = sourceId ? await lockSource(tx, context, sourceId) : undefined;
      const options = cited ? { sourceRecordId: cited.id, observedAt: cited.occurredAt } : {};
      if (request.operation === 'record.create') {
        if (object.isEvent)
          throw new AppError(422, 'use_log_event', 'create events with retainer.events.log');
        const writes = prepareValues(object, named(object, values), 'create');
        const record = await insertRecord(tx, context, object);
        const fields = await writeFields(tx, context, object, record, writes, options);
        return {
          result: { id: record.id, fields: keyedStatus(object, fields) },
          recordId: record.id,
        };
      }
      const id = z.uuid().parse(args.id);
      const record = await lockRecord(tx, workspaceId, id);
      const actual = objectOf(schema, record);
      if (actual.id !== object.id)
        throw new AppError(422, 'wrong_object', `record ${id} is not a ${object.name}`);
      const writes = prepareValues(object, named(object, values), 'update');
      const fields = await writeFields(tx, context, object, record, writes, options);
      return {
        result: { id: record.id, fields: keyedStatus(object, fields) },
        recordId: record.id,
      };
    }
    if (request.operation === 'events.log') {
      const input = logEventInputSchema.parse(args);
      const type = objectFor(schema, input.type);
      const fields = type ? named(type, input.fields) : input.fields;
      const logged = await logEvent(tx, context, {
        ...input,
        ...(type ? { type: type.name } : {}),
        fields,
      });
      return { result: { id: logged.id }, recordId: logged.id };
    }
    if (request.operation === 'remember') {
      const about = String(args.about ?? '');
      if (about === 'me') throw forbidden('a routine cannot read or write personal memory');
      const input = rememberInputSchema.parse({
        text: args.text,
        ...(args.quote ? { quote: args.quote } : {}),
        ...((await this.defaultSource(tx, context, run, args.source))
          ? { source: await this.defaultSource(tx, context, run, args.source) }
          : {}),
      });
      const plan = await planRemember(tx, context, about, input);
      const { fact } = await rememberFact(tx, context, plan, input);
      return { result: { id: fact.id }, recordId: null };
    }
    throw new AppError(400, 'invalid_request', `unknown write ${request.operation}`);
  }

  /**
   * Starts a tool call (§8, extensions-tools spec 4): checked, queued as the
   * extension's own job with the effect key as its dedupe key, and polled.
   * A test run reports a `send` tool and ends there, before anything is queued.
   */
  private async tool(
    tx: Tx,
    caller: Caller,
    binding: RoutineCaller,
    run: RunState,
    request: RoutineEffectRequest,
    hash: string,
    started: ResultRow | null,
  ): Promise<RoutineEffectResponse> {
    if (started?.tool_job_id) return { state: 'pending', tool: { callId: started.tool_job_id } };
    const name = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,99}$/)
      .parse(request.args.name);
    if (!binding.tools.includes(name))
      throw new AppError(
        403,
        'tool_not_listed',
        `the routine's manifest does not list the tool "${name}"`,
      );
    if (!this.config.catalog || !this.config.queue)
      throw new AppError(409, 'tool_unavailable', 'tool calls are not available on this server');
    const tool = (await installedTools(tx, this.config.catalog)).find((t) => t.name === name);
    if (!tool || tool.status === 'conflict')
      throw new AppError(409, 'tool_unavailable', `the tool "${name}" is not installed`);
    // The tool may have changed since the run started: what the version
    // pinned is checked again before the call is made (§5.3).
    if (!sameContract(run.tool_contracts?.[name], toolContract(tool)))
      throw new AppError(409, 'tool_changed', `the tool "${name}" changed since it was approved`);
    if (run.mode === 'test' && tool.effect === 'send') {
      await this.record(tx, caller.workspaceId, run.id, request, hash, {
        state: 'reported',
        result: request.args,
        code: 'stop',
      });
      return { state: 'reported', stop: true };
    }
    let connectionId: string | null = null;
    if (tool.connection === 'member') {
      // A manual routine uses the account of the person who runs or tests it.
      const owner = run.initiator_user_id;
      const memberTest =
        run.mode === 'test' && run.manifest?.when.kind === 'manual' && !owner?.startsWith('key:');
      if (!owner || (run.trigger_kind !== 'manual' && !memberTest))
        throw new AppError(
          403,
          'member_account',
          'a member tool needs a person to start a manual routine or its test',
        );
      const [connection] = await tx<{ id: string }[]>`
        select id from extension_connections where installation_id=${tool.installationId}
          and owner_id=${owner} and state='active'`;
      if (!connection)
        throw new AppError(409, 'tool_not_connected', 'connect your account to use this tool');
      connectionId = connection.id;
    } else if (tool.status !== 'ready')
      throw new AppError(409, 'tool_not_connected', `the tool "${name}" is not connected`);
    await this.useRecord(tx, caller.workspaceId, run);
    const self = run.routine_id ?? run.id;
    // The call must end within this attempt (§8): past its deadline the run has ended.
    const expiresAt = run.deadline ?? new Date(Date.now() + ROUTINE_LIMITS.maxRunSeconds * 1000);
    const jobId = await this.config.queue.enqueueTool(tx, caller.workspaceId, {
      installationId: tool.installationId,
      connectionId,
      functionId: tool.functionId,
      input: request.args.input ?? {},
      dedupeKey: `routine:${run.id}:${request.position}`,
      cause: [...new Set([...run.cause, self])],
      depth: run.cause_depth + 1,
      expiresAt,
      callerRunId: run.id,
      callerUserId: connectionId ? run.initiator_user_id : null,
    });
    await this.record(tx, caller.workspaceId, run.id, request, hash, {
      state: 'started',
      toolJobId: jobId,
    });
    return { state: 'pending', tool: { callId: jobId } };
  }

  /**
   * A model call (§6.3): reserved before it is made, against the run's cap
   * and the workspace's day, in one step; the answer comes back by
   * `modelResult`. A retried call that already has a token is not counted again.
   */
  private async model(
    tx: Tx,
    caller: Caller,
    run: RunState,
    request: RoutineEffectRequest,
    hash: string,
    started: ResultRow | null,
  ): Promise<RoutineEffectResponse> {
    if (!this.config.modelAvailable || !this.config.modelOrigin)
      throw new AppError(409, 'model_unavailable', 'this server has no model');
    if (run.mode !== 'build' && !run.manifest?.uses.model)
      throw new AppError(
        403,
        'model_not_declared',
        'the manifest does not say the routine uses a model',
      );
    if (!started) {
      if (this.config.modelCallsPerDay <= 0)
        throw refused('budget_exhausted', 'this server allows no routine model calls');
      if (run.model_calls >= ROUTINE_LIMITS.modelCallsPerRun)
        throw refused(
          'budget_exhausted',
          `a run makes at most ${ROUTINE_LIMITS.modelCallsPerRun} model calls`,
        );
      const [day] = await tx<{ count: number }[]>`
        insert into routine_model_days(workspace_id,day,count)
        values(${caller.workspaceId},(clock_timestamp() at time zone 'UTC')::date,1)
        on conflict(workspace_id,day) do update set count=routine_model_days.count+1
          where routine_model_days.count<${this.config.modelCallsPerDay}
        returning count`;
      if (!day)
        throw refused('budget_exhausted', 'the workspace used its routine model calls for today');
      await tx`update routine_runs set model_calls=model_calls+1 where id=${run.id}`;
      await this.record(tx, caller.workspaceId, run.id, request, hash, { state: 'started' });
    }
    const until = run.deadline ?? new Date(Date.now() + ROUTINE_LIMITS.maxRunSeconds * 1000);
    const token = await this.config.tokens.issueRoutineModel(
      {
        kind: 'routine',
        workspaceId: caller.workspaceId,
        routineId: run.routine_id,
        runId: run.id,
        position: request.position,
        attempt: Math.max(run.attempt, 1),
        model: this.config.modelName,
        maxTokens: ROUTINE_LIMITS.modelOutputTokens,
      },
      until,
    );
    return {
      state: 'model',
      model: {
        origin: this.config.modelOrigin,
        token,
        name: this.config.modelName,
        maxTokens: ROUTINE_LIMITS.modelOutputTokens,
      },
    };
  }

  /** The model's answer for a started model call, recorded so a retry reuses it. */
  async modelResult(caller: Caller, position: number, result: unknown) {
    const binding = this.binding(caller);
    if (Buffer.byteLength(stableJson(result ?? null)) > ROUTINE_LIMITS.resultBytes)
      throw new AppError(413, 'quota_exceeded', 'a model result exceeds 64 KiB');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitCaller(tx, caller);
      const [row] = await tx<ResultRow[]>`
        select * from routine_run_results where run_id=${binding.runId} and position=${position} for update`;
      if (!row || row.operation !== 'ai.generate') throw notFound('model call');
      if (row.state === 'done')
        return { state: 'done' as const, result: row.result, replayed: true };
      // A refusal already recorded stands: a retry must get the same error.
      if (row.state === 'failed')
        throw new AppError(422, row.code ?? 'model_failed', 'this call failed');
      await tx`update routine_run_results set state='done',result=${tx.json(jsonValue(result ?? null))},updated_at=clock_timestamp()
        where run_id=${binding.runId} and position=${position}`;
      return { state: 'done' as const, result, replayed: false };
    });
  }

  /**
   * A started model call the provider refused, or whose answer was unusable:
   * kept as a failed call with the provider's words, so the run's page says
   * why and a retry gets the same error at this position.
   */
  async modelFailed(caller: Caller, position: number, error: { code: string; message: string }) {
    const binding = this.binding(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitCaller(tx, caller);
      const [row] = await tx<ResultRow[]>`
        select * from routine_run_results where run_id=${binding.runId} and position=${position} for update`;
      if (!row || row.operation !== 'ai.generate') throw notFound('model call');
      if (row.state === 'started')
        await tx`update routine_run_results set state='failed',code=${error.code},
          result=${tx.json({ error: error.message })},updated_at=clock_timestamp()
          where run_id=${binding.runId} and position=${position}`;
      return { state: 'failed' as const, code: row.state === 'started' ? error.code : row.code };
    });
  }

  /**
   * Polls a tool call this run started (extensions-tools spec 4): only the
   * run that started it gets its status or output; anyone else gets a 404.
   */
  async poll(caller: Caller, position: number): Promise<RoutineEffectResponse> {
    const binding = this.binding(caller);
    // A failed call is recorded, then thrown once its transaction commits.
    const polled = await inWorkspace(
      this.sql,
      caller.workspaceId,
      async (tx): Promise<RoutineEffectResponse | { failed: string }> => {
        await lockSchemaShared(tx, caller.workspaceId);
        await admitCaller(tx, caller);
        const [row] = await tx<ResultRow[]>`
        select * from routine_run_results where run_id=${binding.runId} and position=${position} for update`;
        if (!row || row.operation !== 'tool') throw notFound('tool call');
        if (row.state === 'done') return { state: 'done', result: row.result, replayed: true };
        if (row.state === 'failed')
          throw new AppError(422, row.code ?? 'tool_failed', 'the tool call failed');
        if (row.state === 'reported') return { state: 'reported', stop: row.code === 'stop' };
        const [job] = await tx<{ status: string; code: string | null; output: unknown }[]>`
        select status,code,output from extension_jobs where id=${row.tool_job_id} and caller_run_id=${binding.runId}`;
        if (!job) throw notFound('tool call');
        if (job.status === 'succeeded') {
          await tx`update routine_run_results set state='done',result=${tx.json(jsonValue(job.output ?? null))},updated_at=clock_timestamp()
          where run_id=${binding.runId} and position=${position}`;
          return { state: 'done', result: job.output ?? null, replayed: false };
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
          const code = job.code ?? 'tool_failed';
          await tx`update routine_run_results set state='failed',code=${code},updated_at=clock_timestamp()
          where run_id=${binding.runId} and position=${position}`;
          return { failed: code };
        }
        return { state: 'pending', tool: { callId: row.tool_job_id as string } };
      },
    );
    if ('failed' in polled) throw new AppError(422, polled.failed, 'the tool call failed');
    return polled;
  }
}

function keyedStatus(object: CompiledObject, fields: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [name, status] of Object.entries(fields))
    out[object.fieldsByName.get(name)?.key ?? name] = status;
  return out;
}

export { getSchema };
