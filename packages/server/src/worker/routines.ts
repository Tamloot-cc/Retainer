import { type ExecutionResult, executionResultSchema } from '@retainer/extension';
import {
  ROUTINE_LIMITS,
  ROUTINE_STOP_CODES,
  type RoutineInvocation,
  type RoutineManifest,
  type RoutineRunMode,
  type ToolContract,
} from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockSchemaShared, type Tx } from '../db/tx.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import { installedTools, toolContract } from '../extensions/tools.js';
import { matchingRecords } from '../records/query.js';
import { resolveRecordId } from '../records/write.js';
import { stillAdmin } from '../routine-runtime/admission.js';
import type { RoutineConfig } from '../routines/capabilities.js';
import { mapFilter, objectFor } from '../routines/manifest.js';
import { dispatchRoutines, fireSchedule } from '../routines/matcher.js';
import { RUN_GRACE_SECONDS as GRACE_SECONDS, pauseRoutine, usedUp } from '../routines/runs.js';
import { getSchema } from '../schema/compiled.js';
import type { Executable } from './extensions.js';

/** Runs the routine runner bundle in a fresh, closed execution (§3.3). */
export type RoutineDriver = {
  invoke: (
    executable: Executable,
    invocation: RoutineInvocation,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>;
};

/** Failed runs in a row before the routine pauses (§6.2). */
const FAILURES_BEFORE_PAUSE = 3;

export type ClaimedRun = {
  workspaceId: string;
  runId: string;
  routineId: string | null;
  mode: RoutineRunMode;
  fence: string;
  tools: string[];
  attempt: number;
  deadline: Date;
};

type ClaimRow = {
  id: string;
  routine_id: string | null;
  version_id: string | null;
  mode: RoutineRunMode;
  status: string;
  record_id: string | null;
  attempt: number;
  expired: boolean;
  expires_at: Date | null;
  initiator_user_id: string | null;
  manifest: RoutineManifest | null;
  routine_status: string | null;
  active_version_id: string | null;
  tool_contracts: Record<string, ToolContract> | null;
  approver_user_id: string | null;
};

/** Seconds a run of this mode may take (§4.6). The builder makes several model calls. */
const timeoutFor = (mode: RoutineRunMode) =>
  mode === 'build' ? ROUTINE_LIMITS.maxRunSeconds : ROUTINE_LIMITS.runSeconds;

const sameContract = (a: ToolContract | undefined, b: ToolContract | undefined) =>
  !!a &&
  !!b &&
  a.registrationId === b.registrationId &&
  a.effect === b.effect &&
  a.connection === b.connection &&
  a.model === b.model;

/**
 * The trusted side of routine runs (§6.2): it claims due runs, checks what
 * Retainer decides before the code runs (the `if`, `oncePerRecord`, a
 * paused routine, a changed tool contract, the approver), then starts the
 * routine runner with IDs and a token only. It never runs routine code.
 */
export class RoutineExecutor {
  private stopped = false;
  constructor(
    private readonly options: {
      sql: Sql;
      discoverySql: Sql;
      tokens: RunTokens;
      driver: RoutineDriver;
      executable: Executable;
      apiOrigin: string;
      owner: string;
      config: RoutineConfig;
      concurrency?: number;
    },
  ) {}

  stop() {
    this.stopped = true;
  }

  /** One pass: claims due runs and executes them, a few at a time. */
  async tick(limit = 100) {
    if (this.stopped) return { executed: 0 };
    const due = await this.options.discoverySql<{ workspace_id: string; run_id: string }[]>`
      select * from retainer_routine_runs_due(${limit})`;
    let next = 0,
      executed = 0;
    const worker = async () => {
      for (;;) {
        if (this.stopped) return;
        const item = due[next++];
        if (!item) return;
        const claimed = await this.claim(item.workspace_id, item.run_id).catch((e) => {
          if (process.env.ROUTINE_DEBUG) console.error('claim failed', e);
          return null;
        });
        if (!claimed) continue;
        await this.execute(claimed);
        executed++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.concurrency ?? 4, due.length) }, worker),
    );
    return { executed };
  }

  /** Ends a run that will not start, with its status and code. */
  private async end(tx: Tx, id: string, status: string, code: string | null) {
    await tx`update routine_runs set status=${status},code=${code},finished_at=clock_timestamp(),
      lease_owner=null,lease_until=null where id=${id}`;
  }

  /**
   * Claims a run and decides, as fixed logic, whether its code starts
   * (§4.3, §5.3): a run whose `if` fails is skipped without starting any code.
   */
  async claim(workspace: string, id: string): Promise<ClaimedRun | null> {
    return this.claimIn(workspace, id).catch((e) => {
      // Another claim started this routine on the same record first (§6.2).
      if ((e as { constraint_name?: string }).constraint_name === 'routine_runs_one_running_uq')
        return null;
      throw e;
    });
  }

  private async claimIn(workspace: string, id: string): Promise<ClaimedRun | null> {
    return inWorkspace(this.options.sql, workspace, async (tx) => {
      await lockSchemaShared(tx, workspace);
      const [run] = await tx<ClaimRow[]>`
        select r.id,r.routine_id,r.version_id,r.mode,r.status,r.record_id,r.attempt,r.initiator_user_id,r.expires_at,
          coalesce(r.expires_at<=clock_timestamp(),false) as expired,s.manifest,rt.status as routine_status,
          rt.active_version_id,v.tool_contracts,v.approver_user_id
        from routine_runs r left join routine_sources s on s.id=r.source_id
        left join routines rt on rt.id=r.routine_id left join routine_versions v on v.id=r.version_id
        where r.id=${id} and ((r.status='queued' and r.available_at<=clock_timestamp())
          or (r.status='running' and r.lease_until<=clock_timestamp()))
        for update of r skip locked`;
      if (!run) return null;
      if (run.expired) {
        await this.end(tx, id, 'expired', 'run_expired');
        return null;
      }
      if (run.attempt >= ROUTINE_LIMITS.attempts) {
        await this.end(tx, id, 'failed', 'retry_exhausted');
        return null;
      }
      const schema = await getSchema(tx, workspace);
      if (run.mode === 'run') {
        if (!run.routine_id || run.routine_status === 'archived') {
          await this.end(tx, id, 'discarded', 'archived');
          return null;
        }
        if (run.routine_status !== 'active') {
          await tx`update routine_runs set status='held',code='paused',lease_owner=null,lease_until=null where id=${id}`;
          return null;
        }
        if (run.attempt === 0 && run.version_id !== run.active_version_id) {
          await this.end(tx, id, 'discarded', 'new_version');
          return null;
        }
        // A changed tool contract or a departed approver pauses before the run (§5.3).
        const installed = this.options.config.catalog
          ? await installedTools(tx, this.options.config.catalog)
          : [];
        const changed = (run.manifest?.uses.tools ?? []).some((name) => {
          const tool = installed.find((t) => t.name === name && t.status !== 'conflict');
          return !sameContract(run.tool_contracts?.[name], tool ? toolContract(tool) : undefined);
        });
        const approver = await stillAdmin(tx, workspace, run.approver_user_id);
        if (changed || !approver) {
          await pauseRoutine(
            tx,
            run.routine_id,
            'needs_attention',
            changed ? 'tool_changed' : 'approver_left',
          );
          await tx`update routine_runs set status='held',code=${changed ? 'tool_changed' : 'approver_left'},
            lease_owner=null,lease_until=null where id=${id}`;
          return null;
        }
      }
      if (run.mode === 'test' && !(await stillAdmin(tx, workspace, run.initiator_user_id))) {
        await this.end(tx, id, 'stopped', 'not_admin');
        return null;
      }
      let expiry: Date | null = run.expires_at;
      // A run is always on the surviving record (§6.1): a merged ID resolves
      // here, and the claim stores it, so the unique index on running runs
      // keeps one run of a routine on a record at a time.
      let recordId: string | null = null;
      if (run.record_id) {
        recordId = await resolveRecordId(tx, workspace, run.record_id).catch(() => null);
        if (recordId) {
          // The lock makes a merge wait for this claim. A merge takes the
          // record before its runs and a claim the run first, so a record a
          // merge holds is skipped, not waited for; a merge that already got
          // in leaves the run for the next tick, which resolves it again.
          const [locked] = await tx<{ merged_into_id: string | null }[]>`
            select merged_into_id from records where id=${recordId} for key share skip locked`;
          if (!locked || locked.merged_into_id) return null;
        }
      }
      if (run.record_id && run.manifest && ['run', 'test', 'dry'].includes(run.mode)) {
        const when = run.manifest.when;
        const object = 'object' in when && when.object ? objectFor(schema, when.object) : undefined;
        if (!object || !recordId) {
          await this.end(tx, id, 'skipped', 'record_gone');
          return null;
        }
        if (
          run.mode === 'run' &&
          when.oncePerRecord &&
          run.routine_id &&
          (await usedUp(tx, run.routine_id, recordId))
        ) {
          await this.end(tx, id, 'skipped', 'record_used_up');
          return null;
        }
        const filter = run.manifest.if ? mapFilter(object, run.manifest.if, 'name') : undefined;
        const [hit] = await tx<{ data: Record<string, unknown> }[]>`
          select r.data from records r where r.id=${recordId}
            and ${matchingRecords(tx, workspace, schema, object, filter ? { filter } : {}, 'source')}`;
        // The `if` is checked against the record as it is now (§4.3); no code runs when it fails.
        if (!hit && run.mode !== 'dry') {
          await this.end(tx, id, 'skipped', filter ? 'condition_false' : 'record_gone');
          return null;
        }
        if (!hit) {
          await this.end(tx, id, 'skipped', 'condition_false');
          return null;
        }
        if (run.manifest.expiry && !expiry) {
          const value = hit.data[run.manifest.expiry.field];
          const at = typeof value === 'string' ? new Date(value) : null;
          if (at && Number.isFinite(at.getTime())) {
            if (at.getTime() <= Date.now()) {
              await this.end(tx, id, 'expired', 'run_expired');
              return null;
            }
            expiry = at;
          }
        }
      }
      // One run of a routine on a record at a time: this one waits for the
      // other. The index decides a race; this check only spares the error. A
      // run that was already running on the merged-away record when another
      // ran on the survivor keeps that ID until it ends, so it counts too.
      if (run.mode === 'run' && run.routine_id && recordId) {
        const [busy] = await tx`select 1 from routine_runs where routine_id=${run.routine_id}
          and (record_id=${recordId} or record_id in (select r.id from records r where r.merged_into_id=${recordId}))
          and mode='run' and status='running' and id<>${id}`;
        if (busy) return null;
      }
      const timeout = timeoutFor(run.mode);
      const [claimed] = await tx<{ fence: string; attempt: number; deadline: Date }[]>`
        update routine_runs set status='running',lease_owner=${this.options.owner},fence=fence+1,attempt=attempt+1,read_calls='{}',
          record_id=coalesce(${recordId}::uuid,record_id),
          lease_until=clock_timestamp()+${timeout + GRACE_SECONDS}*interval '1 second',
          started_at=coalesce(started_at,clock_timestamp()),
          expires_at=coalesce(expires_at,least(clock_timestamp()+${ROUTINE_LIMITS.expiryHours}*interval '1 hour',${expiry}::timestamptz)),
          updated_at=clock_timestamp()
        where id=${id} returning fence::text,attempt,clock_timestamp()+${timeout}*interval '1 second' as deadline`;
      if (!claimed) return null;
      return {
        workspaceId: workspace,
        runId: id,
        routineId: run.routine_id,
        mode: run.mode,
        fence: claimed.fence,
        tools: run.manifest?.uses.tools ?? [],
        attempt: claimed.attempt,
        deadline: claimed.deadline,
      };
    });
  }

  /** Starts the routine runner for one claimed run and records the outcome. */
  async execute(run: ClaimedRun) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, run.deadline.getTime() - Date.now()),
    );
    let result: ExecutionResult;
    try {
      const runToken = await this.options.tokens.issueRoutine(
        run.workspaceId,
        {
          runId: run.runId,
          routineId: run.routineId,
          fence: run.fence,
          mode: run.mode,
          tools: run.tools,
        },
        new Date(run.deadline.getTime() + GRACE_SECONDS * 1000),
      );
      const invocation: RoutineInvocation = {
        kind: 'routine',
        protocolVersion: 1,
        runId: run.runId,
        attempt: run.attempt,
        releaseDigest: this.options.executable.releaseDigest,
        apiOrigin: new URL(this.options.apiOrigin).origin,
        runToken,
        deadline: run.deadline.toISOString(),
      };
      result = executionResultSchema.parse(
        await this.options.driver.invoke(this.options.executable, invocation, controller.signal),
      );
    } catch {
      result = {
        status: 'retry',
        code: controller.signal.aborted ? 'execution_timeout' : 'execution_unavailable',
      };
    } finally {
      clearTimeout(timer);
    }
    await this.complete(run, result);
    return result.status;
  }

  /** Records how a run ended (§6.2); a run already ended by an effect keeps its status. */
  async complete(run: ClaimedRun, result: ExecutionResult) {
    await inWorkspace(this.options.sql, run.workspaceId, async (tx) => {
      const [row] = await tx<
        {
          status: string;
          fence: string;
          attempt: number;
          routine_id: string | null;
          version_id: string | null;
        }[]
      >`
        select status,fence::text,attempt,routine_id,version_id from routine_runs where id=${run.runId} for update`;
      if (!row || row.status !== 'running' || row.fence !== run.fence) return;
      const output = (result.output ?? null) as Record<string, unknown> | null;
      // The runner always answers `succeeded` with the routine's own outcome;
      // a platform failure (the runner never ran) comes back as retry or failed.
      const outcome = result.status === 'succeeded' ? output?.outcome : undefined;
      const code =
        (outcome && outcome !== 'succeeded' && typeof output?.code === 'string'
          ? output.code
          : result.code) ?? null;
      let status: string;
      if (result.status === 'succeeded' && (outcome === 'succeeded' || outcome === undefined))
        status = 'succeeded';
      else if (code === 'lease_expired' || code === 'unauthorized')
        status = row.attempt < ROUTINE_LIMITS.attempts ? 'queued' : 'failed';
      else if (code && Object.hasOwn(ROUTINE_STOP_CODES, code))
        status = ROUTINE_STOP_CODES[code as keyof typeof ROUTINE_STOP_CODES];
      else if (code === 'record_used_up') status = 'skipped';
      else if (result.status === 'retry' && row.attempt < ROUTINE_LIMITS.attempts)
        status = 'queued';
      else status = 'failed';
      if (status === 'queued') {
        await tx`update routine_runs set status='queued',code=${code},lease_owner=null,lease_until=null,
          available_at=clock_timestamp()+${Math.min(300, 15 * 2 ** row.attempt)}*interval '1 second' where id=${run.runId}`;
        return;
      }
      await tx`update routine_runs set status=${status},code=${status === 'succeeded' ? null : code},
        output=${output ? tx.json(jsonValue(output)) : null},finished_at=clock_timestamp(),
        lease_owner=null,lease_until=null where id=${run.runId}`;
      if (run.mode !== 'run' || !row.routine_id) return;
      // The code passed a fresh check against the workspace's new types (§5.3).
      if (typeof output?.typesFingerprint === 'string' && row.version_id && status !== 'failed')
        await tx`update routine_versions set types_fingerprint=${output.typesFingerprint} where id=${row.version_id}`;
      if (code === 'check_failed') {
        await pauseRoutine(tx, row.routine_id, 'needs_attention', 'check_failed');
        return;
      }
      if (status === 'failed') {
        const [routine] = await tx<{ failures: number }[]>`
          update routines set failures=failures+1 where id=${row.routine_id} returning failures`;
        if ((routine?.failures ?? 0) >= FAILURES_BEFORE_PAUSE)
          await pauseRoutine(tx, row.routine_id, 'needs_attention', 'failing');
      } else if (status === 'succeeded')
        await tx`update routines set failures=0 where id=${row.routine_id}`;
    });
  }
}

/**
 * Routine matching, schedules and retention (§6.1, §6.6). It runs in the
 * change maintenance tick, beside extension dispatch, and needs no executor:
 * a workspace with routines and no extension installed is still found.
 */
export class RoutineMaintenance {
  private stopped = false;
  constructor(
    private readonly sql: Sql,
    private readonly discoverySql: Sql,
  ) {}
  stop() {
    this.stopped = true;
  }
  /** Matching and schedules (§6.1): the maintenance tick calls this beside extension dispatch. */
  async maintain(budgetMs = 30000) {
    const deadline = Date.now() + budgetMs;
    let queued = 0,
      failed = 0;
    const changes = await this.discoverySql<{ workspace_id: string }[]>`
      select * from retainer_routine_changes_due(1000)`;
    for (const { workspace_id: workspace } of changes) {
      if (this.stopped || Date.now() >= deadline) break;
      try {
        queued += (await dispatchRoutines(this.sql, workspace)).queued;
      } catch {
        failed++;
      }
    }
    const schedules = await this.discoverySql<{ workspace_id: string; routine_id: string }[]>`
      select * from retainer_routine_schedules_due(1000)`;
    for (const item of schedules) {
      if (this.stopped || Date.now() >= deadline) break;
      try {
        queued += (await fireSchedule(this.sql, item.workspace_id, item.routine_id)).queued;
      } catch {
        failed++;
      }
    }
    await this.retention(deadline).catch(() => failed++);
    return { queued, failed };
  }

  /** Stored results are kept 7 days after a run ends; finished runs 30 (§6.6). */
  private async retention(deadline: number) {
    const due = await this.discoverySql<{ workspace_id: string }[]>`
      select * from retainer_routine_retention_due(100)`;
    for (const { workspace_id: workspace } of due) {
      if (this.stopped || Date.now() >= deadline) return;
      await inWorkspace(this.sql, workspace, async (tx) => {
        await tx`update routine_runs set output=null where finished_at<clock_timestamp()-interval '7 days'
          and output is not null`;
        await tx`update routine_run_results x set result=null from routine_runs r
          where r.id=x.run_id and r.finished_at<clock_timestamp()-interval '7 days' and x.result is not null`;
        // A tool call's input and output are stored results too.
        await tx`update extension_jobs j set input='{}'::jsonb,output=null,input_hash='' from routine_runs r
          where r.id=j.caller_run_id and r.finished_at<clock_timestamp()-interval '7 days'
            and j.status in ('succeeded','failed','cancelled') and (j.input<>'{}'::jsonb or j.output is not null)`;
        await tx`delete from routine_runs where id in(select id from routine_runs
          where finished_at<clock_timestamp()-interval '30 days' order by finished_at limit 1000)`;
      });
    }
  }
}
