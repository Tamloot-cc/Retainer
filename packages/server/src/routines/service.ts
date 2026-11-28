import { createHash } from 'node:crypto';
import {
  type Actor,
  type FactsNames,
  type RoutineManifest,
  type RoutineProblem,
  type RoutineReport,
  routineFacts,
  routineReportSchema,
  type ToolContract,
  type ToolEffect,
} from '@retainer/shared';
import { z } from 'zod';
import { cancelRunTasks } from '../agent-runtime/tasks.js';
import type { Caller } from '../caller.js';
import { recheckElevation } from '../db/cli.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { toolContract } from '../extensions/tools.js';
import { adminIdentity, stillAdmin } from '../routine-runtime/admission.js';
import { getSchema } from '../schema/compiled.js';
import { stableJson } from '../stable-json.js';
import { type Capabilities, capabilities, type RoutineConfig } from './capabilities.js';
import { nextInZone } from './cron.js';
import { checkCode, checkManifest, fieldFor, objectFor } from './manifest.js';
import { fireTick, matchingSince, scheduleTargets } from './matcher.js';
import { pauseRoutine, queueRun } from './runs.js';

/** A manifest and its code, as written: what `validate_routine` checks. */
export const sourceInputSchema = z.strictObject({
  manifest: z.unknown(),
  code: z.string().max(200000),
});
/**
 * A source as written, or one already checked, by the `sourceId` a check or
 * a preview answered (routines-in-chat spec §4.1). The code is sent once.
 */
export const sourceRefSchema = z.strictObject({
  manifest: z.unknown().optional(),
  code: z.string().max(200000).optional(),
  sourceId: z
    .uuid()
    .optional()
    .describe(
      'A sourceId that validate_routine or preview_routine answered, instead of manifest and code.',
    ),
});
export const proposeInputSchema = sourceRefSchema.extend({
  routineId: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10000),
  summary: z.string().trim().min(1).max(500),
  report: routineReportSchema,
});
export type ProposeInput = z.infer<typeof proposeInputSchema>;
type SourceRef = z.infer<typeof sourceRefSchema>;

/** A source by its ID, or as written; one or the other, never both. */
async function resolveSource(
  tx: Tx,
  input: SourceRef,
): Promise<{ manifest: unknown; code: string }> {
  if (input.sourceId) {
    if (input.manifest !== undefined || input.code !== undefined)
      throw new AppError(422, 'invalid_request', 'send sourceId, or manifest and code, not both');
    const [row] = await tx<{ manifest: unknown; code: string }[]>`
      select manifest,code from routine_sources where id=${input.sourceId}`;
    if (!row) throw notFound('routine draft');
    return row;
  }
  if (input.manifest === undefined || typeof input.code !== 'string')
    throw new AppError(422, 'invalid_request', 'send manifest and code, or a sourceId');
  return { manifest: input.manifest, code: input.code };
}

/**
 * A check job as `validate_routine` answers it, with its `sourceId` on
 * every path (routines-in-chat spec §4.1).
 */
export function checkAnswer(job: {
  id: string;
  status: string;
  code: string | null;
  output: Record<string, unknown> | null;
  sourceId?: string | null;
}) {
  const base = { jobId: job.id, status: job.status, sourceId: job.sourceId ?? null };
  if (job.status === 'succeeded' && job.output)
    return {
      valid: job.output.valid === true,
      problems: (job.output.problems as unknown[]) ?? [],
      ...base,
    };
  if (['queued', 'running'].includes(job.status)) return { valid: null, problems: [], ...base };
  return {
    valid: false,
    problems: [
      { part: 'code', code: job.code ?? 'check_failed', message: 'the type-check could not run' },
    ],
    ...base,
  };
}

const sourceHash = (manifest: RoutineManifest, code: string) =>
  createHash('sha256').update(stableJson({ manifest, code })).digest('hex');

/** The head of the workspace's change feed: a routine starts from here (§6.1). */
export async function feedHead(tx: Tx, workspace: string): Promise<string> {
  const [row] = await tx<{ position: string }[]>`
    select position::text from change_counters where workspace_id=${workspace}`;
  return row?.position ?? '0';
}

export async function saveSource(
  tx: Tx,
  workspace: string,
  manifest: RoutineManifest,
  code: string,
) {
  const hash = sourceHash(manifest, code);
  const [row] = await tx<{ id: string }[]>`
    insert into routine_sources(workspace_id,hash,manifest,code)
    values(${workspace},${hash},${tx.json(jsonValue(manifest))},${code})
    on conflict(workspace_id,hash) do update set created_at=clock_timestamp() returning id`;
  if (!row) throw new Error('source insert returned no row');
  return row.id;
}

/** Plain names for Retainer's facts, from the current schema and tools. */
export function factsNames(caps: Pick<Capabilities, 'objects' | 'tools'>): FactsNames {
  return {
    object: (id) => {
      const object = caps.objects.find((o) => o.universalId === id || o.name === id);
      return {
        singular: object?.label.toLowerCase() ?? 'record',
        plural: object?.label.toLowerCase() ?? 'records',
        isEvent: object?.isEvent ?? false,
      };
    },
    field: (objectId, key) =>
      caps.objects
        .find((o) => o.universalId === objectId || o.name === objectId)
        ?.fields.find((f) => f.key === key)
        ?.label.toLowerCase() ?? key,
    tool: (name) => {
      const tool = caps.tools.find((t) => t.name === name);
      return tool ? { title: tool.title, effect: tool.effect } : undefined;
    },
  };
}

/** Routines are workspace-level: agents and people with access read them. */
function readScope(caller: Caller) {
  if (caller.run || caller.installation || caller.routine)
    throw forbidden('extensions and routines cannot read or change routines');
}
function requireAdmin(caller: Caller) {
  const who = adminIdentity(caller);
  if (!who) throw forbidden('Only a workspace admin can approve, test or change a routine.');
  return who;
}

export class Routines {
  constructor(
    private readonly sql: Sql,
    private readonly config: RoutineConfig,
  ) {}

  /**
   * Wakes the executor once the transaction that queued a run has committed,
   * so someone waiting on the run sees it start promptly (`RoutineConfig.wake`).
   */
  private async woken<T>(work: Promise<T>, queued: (result: T) => boolean): Promise<T> {
    const result = await work;
    if (this.config.wake && queued(result)) await this.config.wake();
    return result;
  }

  private tx<T>(caller: Caller, fn: (tx: Tx) => Promise<T>) {
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      return fn(tx);
    });
  }

  /** `get_routine_capabilities` (§5.1). */
  async capabilities(caller: Caller) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const { installed: _installed, ...caps } = await capabilities(
        tx,
        await getSchema(tx, caller.workspaceId),
        this.config,
      );
      return caps;
    });
  }

  /** The checks that need no sandbox: the manifest completely, the code's shape. */
  private staticCheck(tx: Tx, caller: Caller, input: { manifest: unknown; code: string }) {
    return staticCheck(tx, caller.workspaceId, this.config, input);
  }

  /**
   * `validate_routine` (§5.1): the manifest is checked here; the code's
   * type-check runs in the sandbox, as a `check` job to poll.
   */
  async validate(caller: Caller, input: z.infer<typeof sourceInputSchema>) {
    readScope(caller);
    const validated = this.tx(caller, async (tx) => {
      const { manifest, problems, caps } = await this.staticCheck(tx, caller, input);
      if (problems.length) return { valid: false as const, problems };
      const sourceId = await saveSource(tx, caller.workspaceId, manifest, input.code);
      const passed = await this.checkPassed(tx, sourceId, caps.typesFingerprint);
      if (passed) return { valid: true as const, problems: [], jobId: passed, sourceId };
      const jobId = await queueRun(tx, caller.workspaceId, {
        mode: 'check',
        triggerKind: 'check',
        sourceId,
        initiatedBy: caller.actor,
        input: { typesFingerprint: caps.typesFingerprint },
      });
      return { valid: null, problems: [], jobId, status: 'queued' as const, sourceId };
    });
    return this.woken(validated, (result) => 'status' in result);
  }

  /** A check of this source against these types that passed, if one did. */
  private async checkPassed(tx: Tx, sourceId: string, typesFingerprint: string) {
    const [row] = await tx<{ id: string }[]>`
      select id from routine_runs where source_id=${sourceId} and mode='check' and status='succeeded'
        and output->>'valid'='true' and output->>'typesFingerprint'=${typesFingerprint}
      order by created_at desc limit 1`;
    return row?.id;
  }

  /**
   * `preview_routine` (§5.2, item 5): the recent changes the trigger would
   * have matched, and a dry run of the code on up to five of their records.
   */
  async preview(caller: Caller, input: SourceRef) {
    readScope(caller);
    const previewed = this.tx(caller, async (tx) => {
      const source = await resolveSource(tx, input);
      const { manifest, problems, schema } = await this.staticCheck(tx, caller, source);
      if (problems.length) return { valid: false as const, problems };
      const sourceId = await saveSource(tx, caller.workspaceId, manifest, source.code);
      const { matched, records } =
        manifest.when.kind === 'record'
          ? await matchingSince(tx, schema, manifest, 30)
          : manifest.when.kind === 'schedule'
            ? await scheduleTargets(tx, caller.workspaceId, schema, manifest, 5)
            : await recentRecords(tx, schema, manifest.when.object);
      const previewId = crypto.randomUUID();
      const runs: string[] = [];
      const targets: (string | null)[] =
        manifest.when.kind === 'schedule' && !manifest.when.object ? [null] : records.slice(0, 5);
      for (const recordId of targets)
        runs.push(
          await queueRun(tx, caller.workspaceId, {
            mode: 'dry',
            triggerKind: 'preview',
            sourceId,
            recordId,
            previewId,
            initiatedBy: caller.actor,
            initiatorUserId: caller.userId ?? caller.person?.id ?? null,
          }),
        );
      // Nothing to dry-run: the preview is done now, with no ID to poll.
      if (!runs.length)
        return {
          valid: true as const,
          problems: [],
          sourceId,
          previewId: null,
          matched,
          runs,
          done: true,
        };
      return { valid: true as const, problems: [], sourceId, previewId, matched, runs };
    });
    return this.woken(previewed, (result) => !!result.runs?.length);
  }

  /**
   * What a chat's draft card shows that only Retainer may state
   * (routines-in-chat spec §4.1): the source, Retainer's facts, the check
   * Propose would run, the trigger's count now, the stored dry run when it
   * is of this source, and the proposals made from it. It only reads: no
   * sandbox job is queued, so opening a card costs nothing.
   */
  async draft(
    caller: Caller,
    sourceId: string,
    options: { previewId?: string | undefined; routineId?: string | undefined } = {},
  ) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const [source] = await tx<{ id: string; manifest: unknown; code: string }[]>`
        select id,manifest,code from routine_sources where id=${sourceId}`;
      if (!source) throw notFound('routine draft');
      const { manifest, problems, schema, caps } = await this.staticCheck(tx, caller, source);
      if (options.routineId) {
        const [routine] = await tx<{ status: string }[]>`
          select status from routines where id=${options.routineId}`;
        if (!routine || routine.status === 'archived')
          problems.push({
            part: 'manifest',
            code: 'routine_archived',
            message: routine ? 'this routine is archived' : 'this routine no longer exists',
          });
      }
      const ok =
        !problems.length && !!(await this.checkPassed(tx, source.id, caps.typesFingerprint));
      // A manifest with problems has no normalized form: show it as stored.
      const shown = (problems.length ? source.manifest : manifest) as RoutineManifest;
      const count = problems.some((p) => p.part === 'manifest')
        ? null
        : await draftCount(tx, caller.workspaceId, schema, manifest);
      let preview: { available: false } | ({ available: true } & PreviewRuns) | null = null;
      if (options.previewId) {
        const found = await previewRuns(tx, options.previewId);
        if (found.rows.some((run) => run.source_id !== source.id))
          throw new AppError(409, 'preview_mismatch', 'this dry run is of another routine draft');
        preview = found.rows.length
          ? { available: true, done: found.done, runs: found.runs }
          : { available: false };
      }
      const versions = await tx<
        (Pick<
          VersionRow,
          | 'id'
          | 'routine_id'
          | 'number'
          | 'name'
          | 'description'
          | 'summary'
          | 'report'
          | 'state'
          | 'built_by'
        > & {
          created_at: Date;
        })[]
      >`select id,routine_id,number,name,description,summary,report,state,built_by,created_at
        from routine_versions where source_id=${source.id} order by created_at,id`;
      return {
        sourceId: source.id,
        manifest: shown,
        code: source.code,
        facts: safeFacts(shown, factsNames(caps)),
        ok,
        problems,
        count,
        preview,
        proposals: versions.map((v) => ({
          routineId: v.routine_id,
          versionId: v.id,
          number: v.number,
          name: v.name,
          description: v.description,
          summary: v.summary,
          report: v.report,
          state: v.state,
          builtBy: v.built_by,
          byYou: v.built_by.type === caller.actor.type && v.built_by.id === caller.actor.id,
          createdAt: v.created_at.toISOString(),
        })),
      };
    });
  }

  /** A preview's dry runs and what each tried, in order. */
  async getPreview(caller: Caller, previewId: string) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const { rows, done, runs } = await previewRuns(tx, previewId);
      if (!rows.length) throw notFound('routine preview');
      return { previewId, done, runs };
    });
  }

  /** A sandbox job: a check, a dry run, a test, a build or a run. */
  async getJob(caller: Caller, id: string) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const [run] = await tx<RunRow[]>`select * from routine_runs where id=${id}`;
      if (!run) throw notFound('routine job');
      return presentRun(tx, run, true);
    });
  }

  /**
   * `propose_routine` (§5.1): saves the description, manifest, code, summary
   * and the report of the agent that built it, for a person to review. The code must have
   * passed a type-check against the workspace's current types.
   */
  async propose(caller: Caller, input: ProposeInput) {
    readScope(caller);
    if (!caller.scopes.includes('write') && !caller.scopes.includes('admin'))
      throw forbidden('proposing a routine needs write access');
    return this.tx(caller, async (tx) => {
      const source = await resolveSource(tx, input);
      const { manifest, problems, caps } = await this.staticCheck(tx, caller, source);
      if (problems.length)
        throw new AppError(422, 'invalid_routine', 'the routine does not pass its checks', {
          problems,
        });
      const sourceId = await saveSource(tx, caller.workspaceId, manifest, source.code);
      if (!(await this.checkPassed(tx, sourceId, caps.typesFingerprint)))
        throw new AppError(
          409,
          'not_validated',
          'validate this manifest and code first (validate_routine) and wait until it passes',
        );
      return insertProposal(tx, caller.workspaceId, caller.actor, input, manifest, sourceId, caps);
    });
  }

  async list(caller: Caller) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const rows = await tx<RoutineRow[]>`
        select r.*,(select count(*)::int from routine_runs h where h.routine_id=r.id and h.status='held') as held,
          (select count(*)::int from routine_versions v where v.routine_id=r.id and v.state='proposed') as proposals,
          ${approverGone(tx)}
        from routines r order by r.created_at desc,r.id`;
      const caps = await capabilities(tx, await getSchema(tx, caller.workspaceId), this.config);
      const versions = await this.versions(
        tx,
        rows.map((r) => r.active_version_id).filter(Boolean) as string[],
      );
      return {
        timeZone: caps.timezone,
        routines: rows.map((row) =>
          presentRoutine(row, versions.get(row.active_version_id ?? ''), caps),
        ),
      };
    });
  }

  private async versions(tx: Tx, ids: string[]) {
    if (!ids.length) return new Map<string, VersionRow>();
    const rows = await tx<VersionRow[]>`
      select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
      where v.id=any(${ids}::uuid[])`;
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** One routine with its versions, its proposals and recent runs. */
  async get(caller: Caller, id: string) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const [row] = await tx<RoutineRow[]>`
        select r.*,(select count(*)::int from routine_runs h where h.routine_id=r.id and h.status='held') as held,
          (select count(*)::int from routine_versions v where v.routine_id=r.id and v.state='proposed') as proposals,
          ${approverGone(tx)}
        from routines r where r.id=${id}`;
      if (!row) throw notFound('routine');
      const caps = await capabilities(tx, await getSchema(tx, caller.workspaceId), this.config);
      const versionRows = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.routine_id=${id} order by v.number desc`;
      const runs = await tx<RunRow[]>`
        select * from routine_runs where routine_id=${id} and mode in ('run','test')
        order by created_at desc,id desc limit 50`;
      const names = factsNames(caps);
      return {
        ...presentRoutine(
          row,
          versionRows.find((v) => v.id === row.active_version_id),
          caps,
        ),
        versions: versionRows.map((version) => presentVersion(version, names)),
        runs: await presentRuns(tx, runs, false),
      };
    });
  }

  async getRun(caller: Caller, routineId: string, runId: string) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const [run] = await tx<RunRow[]>`
        select * from routine_runs where id=${runId} and routine_id=${routineId}`;
      if (!run) throw notFound('routine run');
      return presentRun(tx, run, true);
    });
  }

  /**
   * Approves a proposal (§5.3): only an admin, and checked again first, as a
   * proposed schema change is. The routine starts from the feed's head; runs
   * of the old version not yet started are discarded.
   */
  async approve(caller: Caller, routineId: string, versionId: string) {
    const who = requireAdmin(caller);
    // A recheck is queued and committed before the 409, so its job exists.
    const approved = await this.tx(caller, async (tx) => {
      const [routine] = await tx<
        RoutineRow[]
      >`select * from routines where id=${routineId} for no key update`;
      if (!routine) throw notFound('routine');
      if (routine.status === 'archived')
        throw new AppError(409, 'routine_archived', 'this routine is archived');
      const [version] = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.id=${versionId} and v.routine_id=${routineId} for update of v`;
      if (!version) throw notFound('routine version');
      if (version.state !== 'proposed' && version.id !== routine.active_version_id)
        throw new AppError(409, 'not_a_proposal', 'only a proposal can be approved');
      const { manifest, problems, caps } = await this.staticCheck(tx, caller, {
        manifest: version.manifest,
        code: version.code,
      });
      if (problems.length)
        throw new AppError(409, 'invalid_routine', 'the routine no longer passes its checks', {
          problems,
        });
      if (version.types_fingerprint !== caps.typesFingerprint) {
        const passed = await this.checkPassed(tx, version.source_id, caps.typesFingerprint);
        if (!passed) {
          const [pending] = await tx<{ id: string }[]>`
            select id from routine_runs where source_id=${version.source_id} and mode='check'
              and status in ('queued','running') and input->>'typesFingerprint'=${caps.typesFingerprint}
            limit 1`;
          return {
            checkRequired:
              pending?.id ??
              (await queueRun(tx, caller.workspaceId, {
                mode: 'check',
                triggerKind: 'check',
                sourceId: version.source_id,
                initiatedBy: caller.actor,
                input: { typesFingerprint: caps.typesFingerprint },
              })),
          };
        }
      }
      const contracts: Record<string, ToolContract> = {};
      for (const name of manifest.uses.tools) {
        const tool = caps.installed.find((t) => t.name === name);
        if (tool) contracts[name] = toolContract(tool);
      }
      const sourceId = await saveSource(tx, caller.workspaceId, manifest, version.code);
      const approvedId =
        version.state === 'proposed'
          ? version.id
          : await this.copyVersionForApproval(tx, caller.workspaceId, version, sourceId);
      const discardedRuns = await this.discardUnstarted(tx, routineId);
      await tx`update routine_versions set state='superseded' where routine_id=${routineId} and state='approved'`;
      // Proposals older than the approved version are settled with it, so none
      // can be approved over it by mistake; newer ones stay open for review.
      await tx`update routine_versions set state='superseded' where routine_id=${routineId}
        and state='proposed' and number<${version.number}`;
      await tx`update routine_versions set state='approved',approved_by=${tx.json(jsonValue(caller.actor))},
        approver_user_id=${who},approved_at=clock_timestamp(),types_fingerprint=${caps.typesFingerprint},
        tool_contracts=${tx.json(jsonValue(contracts))},source_id=${sourceId}
        where id=${approvedId}`;
      await this.activate(tx, caller.workspaceId, routineId, manifest, caps.timezone, approvedId);
      return { routineId, versionId: approvedId, discardedRuns };
    });
    if ('checkRequired' in approved) {
      // The recheck is queued and committed: start it before answering.
      await this.config.wake?.();
      throw new AppError(
        409,
        'check_required',
        'the workspace changed since this code was checked; a new check is running, approve again when it passes',
        { jobId: approved.checkRequired },
      );
    }
    return approved;
  }

  private async copyVersionForApproval(
    tx: Tx,
    workspace: string,
    version: VersionRow,
    sourceId: string,
  ) {
    // Approve and resume hold the routine row, serializing version numbers with proposals.
    const [copy] = await tx<{ id: string }[]>`
      insert into routine_versions(workspace_id,routine_id,source_id,number,name,description,summary,report,rank,types_fingerprint,tool_contracts,built_by)
      select ${workspace},v.routine_id,${sourceId},
        (select max(number)+1 from routine_versions where routine_id=v.routine_id),
        v.name,v.description,v.summary,v.report,v.rank,v.types_fingerprint,v.tool_contracts,v.built_by
      from routine_versions v where v.id=${version.id} returning id`;
    if (!copy) throw notFound('routine version');
    return copy.id;
  }

  private async discardUnstarted(tx: Tx, routineId: string) {
    const [discarded] = await tx<{ count: number }[]>`
      with gone as (update routine_runs set status='discarded',code='new_version',finished_at=clock_timestamp()
        where routine_id=${routineId} and mode='run' and attempt=0 and status in ('queued','held') returning 1)
      select count(*)::int as count from gone`;
    return discarded?.count ?? 0;
  }

  /** Active from now: the feed's head, the next schedule occurrence (§5.3, §6.1). */
  private async activate(
    tx: Tx,
    workspace: string,
    routineId: string,
    manifest: RoutineManifest,
    zone: string,
    versionId: string,
  ) {
    const head = await feedHead(tx, workspace);
    const next =
      manifest.when.kind === 'schedule' ? nextInZone(manifest.when.cron, new Date(), zone) : null;
    await tx`update routines r set status='active',paused_reason=null,paused_at=null,failures=0,
      name=coalesce(v.name,r.name),description=coalesce(v.description,r.description),
      feed_position=${manifest.when.kind === 'record' ? head : null}::bigint,next_fire_at=${next},
      active_version_id=v.id from routine_versions v where r.id=${routineId} and v.routine_id=r.id
        and v.id=${versionId}`;
  }

  async reject(caller: Caller, routineId: string, versionId: string) {
    requireAdmin(caller);
    return this.tx(caller, async (tx) => {
      if (caller.cli) {
        await tx`select id from routine_versions where id=${versionId} and routine_id=${routineId} for update`;
        await recheckElevation(tx, caller.cli, 'admin');
      }
      const [row] = await tx`update routine_versions set state='rejected',
        rejected_by=${caller.cli ? tx.json(jsonValue(caller.actor)) : null}
        where id=${versionId} and routine_id=${routineId} and state='proposed' returning id`;
      if (!row) throw notFound('routine proposal');
      return { routineId, versionId, state: 'rejected' };
    });
  }

  async pause(caller: Caller, routineId: string) {
    requireAdmin(caller);
    return this.tx(caller, async (tx) => {
      const [routine] = await tx<
        RoutineRow[]
      >`select * from routines where id=${routineId} for no key update`;
      if (!routine) throw notFound('routine');
      await recheckElevation(tx, caller.cli, 'admin');
      if (routine.status !== 'active') return { routineId, status: routine.status };
      await pauseRoutine(tx, routineId, 'paused', 'paused');
      await tx`update routines set state_changed_by=${caller.cli ? tx.json(jsonValue(caller.actor)) : null} where id=${routineId}`;
      return { routineId, status: 'paused' };
    });
  }

  /**
   * Resumes a routine from the feed's head (§5.3): changes made while it was
   * paused, and due times that passed, are not handled later.
   */
  async resume(caller: Caller, routineId: string) {
    requireAdmin(caller);
    return this.tx(caller, async (tx) => {
      const [routine] = await tx<
        RoutineRow[]
      >`select * from routines where id=${routineId} for no key update`;
      if (!routine) throw notFound('routine');
      await recheckElevation(tx, caller.cli, 'admin');
      if (!['paused', 'needs_attention'].includes(routine.status))
        throw new AppError(409, 'not_paused', 'only a paused routine can be resumed');
      const [version] = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.id=${routine.active_version_id}`;
      if (!version) throw new AppError(409, 'not_approved', 'approve a version first');
      if (['check_failed', 'tool_changed', 'approver_left'].includes(routine.paused_reason ?? ''))
        throw new AppError(
          409,
          'approval_required',
          'this routine paused because something it depends on changed; repair it and approve the new version',
        );
      // Whoever resumes must not become the approver of code they never saw:
      // an approver who left means approving again, however it paused (#167).
      if (!(await stillAdmin(tx, caller.workspaceId, version.approver_user_id)))
        throw new AppError(
          409,
          'approval_required',
          'its approver is no longer an admin; review and approve the routine to resume it',
          { routineId, versionId: version.id },
        );
      const zone = await workspaceZone(tx);
      await this.activate(tx, caller.workspaceId, routineId, version.manifest, zone, version.id);
      await tx`update routines set state_changed_by=${caller.cli ? tx.json(jsonValue(caller.actor)) : null} where id=${routineId}`;
      return { routineId, status: 'active' };
    });
  }

  async archive(caller: Caller, routineId: string) {
    requireAdmin(caller);
    return this.tx(caller, async (tx) => {
      const [row] =
        await tx`update routines set status='archived',paused_reason=null,next_fire_at=null,feed_position=null
        where id=${routineId} returning id`;
      if (!row) throw notFound('routine');
      await tx`update routine_runs set status='discarded',code='archived',finished_at=clock_timestamp(),
        input=nullif(input-'triggerRecord','{}'::jsonb) where routine_id=${routineId} and status in ('queued','held')`;
      const stopped = await tx<
        { id: string }[]
      >`update routine_runs set status='stopped',code='archived',finished_at=clock_timestamp(),
        lease_owner=null,lease_until=null,fence=fence+1,input=nullif(input-'triggerRecord','{}'::jsonb)
        where routine_id=${routineId} and status in ('running','waiting') returning id`;
      await cancelRunTasks(
        tx,
        stopped.map((run) => run.id),
        'archived',
      );
      return { routineId, status: 'archived' };
    });
  }

  /** Runs or discards the runs a routine holds (§6.5). */
  async releaseHeld(caller: Caller, routineId: string, action: 'run' | 'discard') {
    requireAdmin(caller);
    const released = this.tx(caller, async (tx) => {
      // A paused routine refuses every effect, so its held runs would only be
      // held again: running them needs the routine on first.
      if (action === 'run') {
        const [routine] = await tx<{ status: string }[]>`
          select status from routines where id=${routineId} for no key update`;
        if (!routine) throw notFound('routine');
        if (routine.status !== 'active')
          throw new AppError(
            409,
            'routine_not_active',
            'resume the routine before running its held runs',
          );
      }
      const rows = await tx<{ id: string }[]>`
        update routine_runs set status=${action === 'run' ? 'queued' : 'discarded'},
          code=${action === 'run' ? null : 'discarded_by_admin'},available_at=clock_timestamp(),
          finished_at=${action === 'run' ? null : new Date()}
        where routine_id=${routineId} and status='held' returning id`;
      return { routineId, [action === 'run' ? 'queued' : 'discarded']: rows.length };
    });
    return this.woken(released, (result) => Number(result.queued ?? 0) > 0);
  }

  /**
   * A test before approval (§5.3): an admin, one record they choose, real
   * writes at agent rank, tools declared `send` reported and not called.
   */
  async test(caller: Caller, routineId: string, versionId: string, recordId: string | null) {
    const who = requireAdmin(caller);
    const tested = this.tx(caller, async (tx) => {
      const [version] = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.id=${versionId} and v.routine_id=${routineId}`;
      if (!version) throw notFound('routine version');
      const { manifest, problems, caps, schema } = await this.staticCheck(tx, caller, {
        manifest: version.manifest,
        code: version.code,
      });
      if (problems.length)
        throw new AppError(409, 'invalid_routine', 'the routine no longer passes its checks', {
          problems,
        });
      if (
        !(await this.checkPassed(tx, version.source_id, caps.typesFingerprint)) &&
        version.types_fingerprint !== caps.typesFingerprint
      )
        throw new AppError(409, 'check_required', 'validate the routine again first');
      await requireRecordFor(tx, schema, manifest, recordId);
      const id = await queueRun(tx, caller.workspaceId, {
        mode: 'test',
        triggerKind: 'test',
        routineId,
        versionId,
        sourceId: version.source_id,
        recordId,
        initiatedBy: caller.actor,
        initiatorUserId: who,
      });
      return { runId: id };
    });
    return this.woken(tested, () => true);
  }

  /** A person presses a routine's button on one or more records (§4.2, `manual`). */
  async runManual(caller: Caller, routineId: string, recordIds: string[]) {
    readScope(caller);
    if (caller.actor.type !== 'user') throw forbidden('only a person presses a routine button');
    if (!caller.scopes.includes('write') && !caller.scopes.includes('admin'))
      throw forbidden('running a routine needs write access');
    const pressed = this.tx(caller, async (tx) => {
      // Enqueue before a competing pause, or observe the pause and refuse.
      const [routine] = await tx<RoutineRow[]>`
        select * from routines where id=${routineId} for no key update`;
      if (!routine || !routine.active_version_id) throw notFound('routine');
      if (routine.status !== 'active')
        throw new AppError(409, 'routine_paused', 'the routine is not active');
      const [version] = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.id=${routine.active_version_id}`;
      if (version?.manifest.when.kind !== 'manual')
        throw new AppError(409, 'not_manual', 'this routine has no button');
      const schema = await getSchema(tx, caller.workspaceId);
      const runs: string[] = [];
      for (const recordId of [...new Set(recordIds)]) {
        await requireRecordFor(tx, schema, version.manifest, recordId);
        runs.push(
          await queueRun(tx, caller.workspaceId, {
            mode: 'run',
            triggerKind: 'manual',
            routineId,
            versionId: version.id,
            sourceId: version.source_id,
            recordId,
            initiatedBy: caller.actor,
            initiatorUserId: caller.person?.id ?? caller.userId ?? caller.actor.id,
          }),
        );
      }
      return { runs };
    });
    return this.woken(pressed, (result) => result.runs.length > 0);
  }

  /**
   * Runs an active schedule's tick now, as an admin asks (§4.2): the tick
   * is made due and fired with every rule a due tick has (the fan-out cap,
   * held runs, `oncePerRecord`), and the next regular time stays as it was.
   */
  async runNow(caller: Caller, routineId: string) {
    requireAdmin(caller);
    const fired = this.tx(caller, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      // Held for the whole tick: a regular tick skips the routine meanwhile,
      // and a second press waits, then fires its own tick.
      const [routine] = await tx<RoutineRow[]>`
        select * from routines where id=${routineId} for no key update`;
      if (!routine || !routine.active_version_id) throw notFound('routine');
      if (routine.status !== 'active')
        throw new AppError(409, 'routine_paused', 'the routine is not active');
      const [version] = await tx<VersionRow[]>`
        select v.*,s.manifest,s.code from routine_versions v join routine_sources s on s.id=v.source_id
        where v.id=${routine.active_version_id}`;
      if (!version || version.manifest.when.kind !== 'schedule')
        throw new AppError(409, 'not_schedule', 'only a schedule routine runs now');
      const [now] = await tx<{ at: Date }[]>`select clock_timestamp() as at`;
      // A schedule that no longer fits the workspace pauses in the tick, as a
      // due tick does, rather than being refused here.
      const fired = await fireTick(
        tx,
        caller.workspaceId,
        {
          id: routineId,
          version_id: version.id,
          source_id: version.source_id,
          manifest: version.manifest,
        },
        now?.at ?? new Date(),
      );
      return { routineId, ...fired };
    });
    return this.woken(fired, (result) => result.queued > 0);
  }

  /** Buttons a person can press on a record of this object. */
  async buttons(caller: Caller, object: string) {
    readScope(caller);
    return this.tx(caller, async (tx) => {
      const schema = await getSchema(tx, caller.workspaceId);
      const target = objectFor(schema, object);
      if (!target) throw notFound(`object "${object}"`);
      const rows = await tx<{ id: string; name: string; manifest: RoutineManifest }[]>`
        select r.id,r.name,s.manifest from routines r join routine_versions v on v.id=r.active_version_id
        join routine_sources s on s.id=v.source_id where r.status='active' and s.manifest->'when'->>'kind'='manual'
          and s.manifest->'when'->>'object'=${target.state.universalId} order by r.name`;
      return {
        buttons: rows.map((row) => ({
          routineId: row.id,
          name: row.name,
          label: (row.manifest.when as { label?: string }).label ?? row.name,
        })),
      };
    });
  }

  /** The workspace time zone setting (§7). */
  async setTimeZone(caller: Caller, zone: string) {
    requireAdmin(caller);
    return this.tx(caller, async (tx) => {
      await tx`select retainer_set_workspace_time_zone(${zone})`;
      // Each schedule's next time is read in the new zone.
      const rows = await tx<{ id: string; manifest: RoutineManifest }[]>`
        select r.id,s.manifest from routines r join routine_versions v on v.id=r.active_version_id
        join routine_sources s on s.id=v.source_id where r.status='active' and s.manifest->'when'->>'kind'='schedule'`;
      for (const row of rows)
        if (row.manifest.when.kind === 'schedule')
          await tx`update routines set next_fire_at=${nextInZone(row.manifest.when.cron, new Date(), zone)} where id=${row.id}`;
      return { timeZone: zone };
    });
  }
}

/** Saves a proposal: a new routine, or a new version of one (§5.3). */
export async function insertProposal(
  tx: Tx,
  workspace: string,
  actor: Actor,
  input: Omit<ProposeInput, 'manifest' | 'code'>,
  manifest: RoutineManifest,
  sourceId: string,
  caps: Capabilities,
) {
  let routineId = input.routineId;
  if (routineId) {
    const [routine] = await tx<{ id: string; status: string }[]>`
      select id,status from routines where id=${routineId} for no key update`;
    if (!routine) throw notFound('routine');
    if (routine.status === 'archived')
      throw new AppError(409, 'routine_archived', 'this routine is archived');
  } else {
    const [created] = await tx<{ id: string }[]>`
      insert into routines(workspace_id,name,description,created_by)
      values(${workspace},${input.name},${input.description},${tx.json(jsonValue(actor))})
      returning id`;
    routineId = created?.id as string;
  }
  const contracts: Record<string, ToolContract> = {};
  for (const name of manifest.uses.tools) {
    const tool = caps.installed.find((t) => t.name === name);
    if (tool) contracts[name] = toolContract(tool);
  }
  const [version] = await tx<{ id: string; number: number }[]>`
    insert into routine_versions(workspace_id,routine_id,source_id,number,name,description,summary,report,types_fingerprint,tool_contracts,built_by)
    values(${workspace},${routineId},${sourceId},
      coalesce((select max(number) from routine_versions where routine_id=${routineId}),0)+1,
      ${input.name},${input.description},${input.summary},${tx.json(jsonValue(input.report))},${caps.typesFingerprint},
      ${tx.json(jsonValue(contracts))},${tx.json(jsonValue(actor))})
    returning id,number`;
  return { routineId, versionId: version?.id as string, number: version?.number as number };
}

/** The checks that need no sandbox: the manifest completely, the code's shape. */
export async function staticCheck(
  tx: Tx,
  workspace: string,
  config: RoutineConfig,
  input: { manifest: unknown; code: string },
) {
  const schema = await getSchema(tx, workspace);
  const caps = await capabilities(tx, schema, config);
  const checked = checkManifest(tx, schema, caps, input.manifest);
  const problems: RoutineProblem[] = [...checked.problems, ...checkCode(input.code)];
  return { schema, caps, manifest: checked.manifest, problems };
}

export async function workspaceZone(tx: Tx): Promise<string> {
  const [row] = await tx<{ zone: string | null }[]>`
    select settings->>'timeZone' as zone from workspaces where id=nullif(current_setting('app.workspace_id',true),'')::uuid`;
  return row?.zone ?? 'UTC';
}

/** A record the routine's trigger object holds, live and visible. */
async function requireRecordFor(
  tx: Tx,
  schema: Awaited<ReturnType<typeof getSchema>>,
  manifest: RoutineManifest,
  recordId: string | null,
) {
  const objectId = 'object' in manifest.when ? manifest.when.object : undefined;
  if (!objectId) {
    if (recordId) throw new AppError(422, 'invalid_request', 'this routine runs without a record');
    return;
  }
  if (!recordId) throw new AppError(422, 'invalid_request', 'choose a record to run it on');
  const object = objectFor(schema, objectId);
  const [row] = await tx<{ object_type_id: string }[]>`
    select object_type_id from records where id=${recordId} and deleted_at is null and merged_into_id is null`;
  if (!row || row.object_type_id !== object?.id)
    throw notFound(`${object?.name ?? 'record'} ${recordId}`);
}

/**
 * The trigger's count now, worded by the card (routines-in-chat spec §5.1):
 * changes of the last 30 days before the `if`, the records a schedule's
 * tick reaches before its fan-out limit, or none for a manual routine.
 */
async function draftCount(
  tx: Tx,
  workspace: string,
  schema: Awaited<ReturnType<typeof getSchema>>,
  manifest: RoutineManifest,
): Promise<{ kind: 'record' | 'schedule' | 'schedule_once' | 'manual'; value: number | null }> {
  const when = manifest.when;
  if (when.kind === 'record')
    return { kind: 'record', value: (await matchingSince(tx, schema, manifest, 30, 0)).matched };
  if (when.kind === 'schedule')
    return when.object
      ? {
          kind: 'schedule',
          value: (await scheduleTargets(tx, workspace, schema, manifest, 0)).matched,
        }
      : { kind: 'schedule_once', value: null };
  return { kind: 'manual', value: null };
}

async function recentRecords(
  tx: Tx,
  schema: Awaited<ReturnType<typeof getSchema>>,
  objectId: string,
) {
  const object = objectFor(schema, objectId);
  if (!object) return { matched: 0, records: [] };
  const rows = await tx<{ id: string }[]>`
    select id from records where object_type_id=${object.id} and deleted_at is null and merged_into_id is null
    order by updated_at desc limit 5`;
  return { matched: rows.length, records: rows.map((row) => row.id) };
}

export type RoutineRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: string;
  state_changed_by: Actor | null;
  paused_reason: string | null;
  paused_at: Date | null;
  active_version_id: string | null;
  feed_position: string | null;
  next_fire_at: Date | null;
  failures: number;
  created_by: Actor;
  created_at: Date;
  updated_at: Date;
  held?: number;
  proposals?: number;
  /** The active version's approver is no longer an admin (routines spec §5.3). */
  approver_gone?: boolean;
};
export type VersionRow = {
  id: string;
  routine_id: string;
  source_id: string;
  number: number;
  state: string;
  name: string | null;
  description: string | null;
  summary: string;
  report: RoutineReport;
  rank: string;
  types_fingerprint: string;
  tool_contracts: Record<string, ToolContract>;
  built_by: Actor;
  approved_by: Actor | null;
  rejected_by: Actor | null;
  approver_user_id: string | null;
  approved_at: Date | null;
  created_at: Date;
  manifest: RoutineManifest;
  code: string;
};
export type RunRow = {
  id: string;
  workspace_id: string;
  routine_id: string | null;
  version_id: string | null;
  source_id: string | null;
  mode: string;
  trigger_kind: string;
  record_id: string | null;
  preview_id: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: string;
  code: string | null;
  lease_owner: string | null;
  fence: string;
  lease_until: Date | null;
  attempt: number;
  available_at: Date;
  run_at: Date;
  expires_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  change_position: string | null;
  cause: string[];
  cause_depth: number;
  initiated_by: Actor | null;
  initiator_user_id: string | null;
  model_calls: number;
  created_at: Date;
};

/** Retainer's facts for a manifest, or none when they cannot be worded. */
function safeFacts(manifest: RoutineManifest, names: FactsNames): string[] {
  try {
    return routineFacts(manifest, names);
  } catch {
    return [];
  }
}

type PreviewRuns = { done: boolean; runs: ReturnType<typeof runView>[] };

/** A preview's dry runs in order, whether they are all done, and as history shows them. */
async function previewRuns(tx: Tx, previewId: string): Promise<PreviewRuns & { rows: RunRow[] }> {
  const rows = await tx<RunRow[]>`
    select * from routine_runs where preview_id=${previewId} order by created_at,id`;
  return {
    rows,
    done: rows.every((run) => !['queued', 'running', 'waiting'].includes(run.status)),
    runs: await presentRuns(tx, rows, true),
  };
}

function presentVersion(version: VersionRow, names: FactsNames) {
  const facts = safeFacts(version.manifest, names);
  return {
    id: version.id,
    number: version.number,
    state: version.state,
    ...(version.name === null ? {} : { name: version.name }),
    ...(version.description === null ? {} : { description: version.description }),
    summary: version.summary,
    report: version.report,
    rank: version.rank,
    manifest: version.manifest,
    code: version.code,
    facts,
    builtBy: version.built_by,
    approvedBy: version.approved_by,
    ...(version.rejected_by ? { rejectedBy: version.rejected_by } : {}),
    approvedAt: version.approved_at?.toISOString() ?? null,
    createdAt: version.created_at.toISOString(),
  };
}

/** Pause reasons more telling than `approver_left`: what must change before it runs again. */
const NEEDS_REPAIR = ['check_failed', 'tool_changed', 'schedule_too_large'];

/**
 * Whether a stopped routine's approver is no longer an admin (#167), as the
 * `approver_gone` column; a running or archived routine never asks. The
 * query aliases `routines` as `r`.
 */
const approverGone = (tx: Tx) => tx`case when r.status not in ('active','archived') then
  (select not coalesce(retainer_routine_admin(r.workspace_id,a.approver_user_id),false)
    from routine_versions a where a.id=r.active_version_id) end as approver_gone`;

function presentRoutine(row: RoutineRow, version: VersionRow | undefined, caps: Capabilities) {
  const names = factsNames(caps);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    // A routine paused for another reason whose approver has since left can
    // only be approved again, never simply resumed (#167).
    // A pause that says more (the code must change, or the tool did) keeps its reason.
    pausedReason:
      row.status !== 'active' &&
      row.status !== 'archived' &&
      row.approver_gone &&
      !NEEDS_REPAIR.includes(row.paused_reason ?? '')
        ? 'approver_left'
        : row.paused_reason,
    ...(row.state_changed_by ? { stateChangedBy: row.state_changed_by } : {}),
    pausedAt: row.paused_at?.toISOString() ?? null,
    // A paused routine fires nothing; resuming sets its next time afresh.
    nextFireAt: row.status === 'active' ? (row.next_fire_at?.toISOString() ?? null) : null,
    heldRuns: row.held ?? 0,
    proposals: row.proposals ?? 0,
    activeVersion: version ? presentVersion(version, names) : null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

type CallRow = {
  run_id: string;
  position: number;
  operation: string;
  state: string;
  code: string | null;
  differs: boolean;
  record_id: string | null;
  result: unknown;
  tool_name: string | null;
  tool_effect: ToolEffect | null;
};

/** Runs as history shows them, with every run's calls read in one query. */
export async function presentRuns(tx: Tx, runs: RunRow[], withResults: boolean) {
  if (!runs.length) return [];
  const rows = await tx<CallRow[]>`
    select run_id,position,operation,state,code,differs,record_id,result,tool_name,tool_effect
    from routine_run_results where run_id=any(${runs.map((run) => run.id)}::uuid[])
    order by run_id,position`;
  const byRun = new Map<string, CallRow[]>();
  for (const row of rows) {
    const calls = byRun.get(row.run_id);
    if (calls) calls.push(row);
    else byRun.set(row.run_id, [row]);
  }
  return runs.map((run) => runView(run, byRun.get(run.id) ?? [], withResults));
}

export async function presentRun(tx: Tx, run: RunRow, withResults: boolean) {
  const [view] = await presentRuns(tx, [run], withResults);
  return view as ReturnType<typeof runView>;
}

/** A run as history shows it: statuses, operations and outcomes; results only while kept. */
function runView(run: RunRow, calls: CallRow[], withResults: boolean) {
  const usedAgent = calls.some((call) => call.operation === 'ai.agent');
  return {
    id: run.id,
    routineId: run.routine_id,
    versionId: run.version_id,
    mode: run.mode,
    trigger: run.trigger_kind,
    recordId: run.record_id,
    status: run.status,
    code: run.code,
    attempt: run.attempt,
    at: run.run_at.toISOString(),
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    expiresAt: run.expires_at?.toISOString() ?? null,
    initiatedBy: run.initiated_by,
    sourceId: run.source_id,
    modelCalls: run.model_calls,
    output: run.output,
    calls: calls.map((call) => ({
      position: call.position,
      operation: call.operation,
      state: call.state,
      code: call.code,
      differs: call.differs,
      recordId: call.record_id,
      ...(call.tool_name && call.tool_effect
        ? { tool: { name: call.tool_name, effect: call.tool_effect } }
        : {}),
      ...(withResults && call.result !== null ? { result: call.result } : {}),
    })),
    // A run that waited for an agent task and then diverged needs a person
    // (agent spec §9.2); one that returned before using the answer says so.
    ...(usedAgent && run.status === 'diverged' ? { needsAttention: true } : {}),
    ...(run.output?.agentAnswerUnused === true ? { agentAnswerUnused: true } : {}),
  };
}

export { fieldFor };
