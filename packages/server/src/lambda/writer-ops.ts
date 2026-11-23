import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { WRITER_BUILD_PATTERN } from '../db/writer-build.js';

import { WRITER_ADMISSION_LOCK } from '../db/writer-lease.js';

const BUILD = z.string().regex(WRITER_BUILD_PATTERN);
export const writerOwnership = z.object({
  generation: z.uuid(),
  deployment: z.uuid(),
  candidate: BUILD,
});

export const writerCommands = [
  z.object({ command: z.literal('writer-admission-status'), protocol: z.literal(1) }),
  z.object({
    command: z.literal('writer-admission-close'),
    protocol: z.literal(1),
    ownership: writerOwnership,
    timed: z.boolean(),
    expectedBuilds: z.array(BUILD),
  }),
  z.object({
    command: z.literal('writer-admission-open'),
    protocol: z.literal(1),
    candidate: BUILD,
    ownership: writerOwnership.optional(),
  }),
  z.object({
    command: z.literal('writer-admission-enroll'),
    protocol: z.literal(1),
    generation: z.uuid(),
    candidate: BUILD,
  }),
  z.object({
    command: z.literal('writer-admission-reconcile'),
    protocol: z.literal(1),
    lease: z.uuid(),
    evidence: z.string().trim().min(1).max(500),
  }),
] as const;

type WriterCommand = z.infer<(typeof writerCommands)[number]>;
type Ownership = z.infer<typeof writerOwnership>;
type Connection = Sql | Tx;
type State = {
  generation: string | null;
  deployment: string | null;
  candidate: string | null;
  migrated: boolean;
  timed: boolean;
  closed_at: Date | null;
  builds: string[];
};

async function lookup(sql: Connection): Promise<State | undefined> {
  const [schema] = await sql`select to_regclass('retainer_deploy.admission') as name`;
  if (!schema?.name) return undefined;
  const [row] = await sql<State[]>`
    select generation, deployment, candidate, migrated, timed, closed_at, builds
    from retainer_deploy.admission where singleton`;
  if (!row) throw new Error('writer admission state is missing');
  return row;
}

function owns(state: State, ownership: Ownership) {
  return (
    state.generation === ownership.generation &&
    state.deployment === ownership.deployment &&
    state.candidate === ownership.candidate
  );
}

/** A live deadline or a missing bound prevents DDL. A heartbeat expiry alone is insufficient. */
async function unsettled(sql: Connection) {
  const [row] = await sql`
    select
      exists (select 1 from retainer_deploy.writer_leases where effect is not null or until > clock_timestamp()) or
      exists (select 1 from public.extension_jobs where status = 'running'
        and (run_until is null or lease_until is null or greatest(run_until, lease_until) > clock_timestamp())) or
      exists (select 1 from public.routine_runs where status = 'running'
        and (lease_until is null or lease_until > clock_timestamp()))
      as busy`;
  return row?.busy !== false;
}

export async function writerAdmission(
  sql: Sql,
  event: WriterCommand,
  writerBuild: string | undefined,
) {
  const metadata = { command: event.command, protocol: 1 as const };
  if (event.command === 'writer-admission-status') {
    const state = await lookup(sql);
    if (!state) return { ...metadata, phase: 'unavailable' };
    const [retired] =
      await sql`select 1 from retainer_deploy.retired_builds where build = ${writerBuild ?? null}`;
    const uncertainEffects = await sql`
      select id, build, effect, until
      from retainer_deploy.writer_leases where effect is not null and until <= clock_timestamp()
      order by until, id limit 100`;
    return {
      ...metadata,
      ...state,
      uncertainEffects,
      candidateRetired: !!retired,
      phase: !state.generation ? 'unmanaged' : state.deployment ? 'closed' : 'open',
    };
  }
  return sql.begin(async (tx) => {
    const [lock] = await tx`select pg_try_advisory_xact_lock(${WRITER_ADMISSION_LOCK}) as held`;
    if (lock?.held !== true) return { ...metadata, phase: 'busy' };
    const state = await lookup(tx);
    if (!state) throw new Error('writer admission migration is not applied');
    if (event.command === 'writer-admission-reconcile') {
      const [reconciled] = await tx`
        with cleared as (
          delete from retainer_deploy.writer_leases where id = ${event.lease}
            and effect is not null and until <= clock_timestamp() returning id, build, effect
        )
        insert into retainer_deploy.effect_reconciliations (id, build, effect, evidence)
        select id, build, effect, ${event.evidence} from cleared returning id`;
      const [existing] = reconciled
        ? [reconciled]
        : await tx`
        select id from retainer_deploy.effect_reconciliations where id = ${event.lease} and evidence = ${event.evidence}`;
      if (!existing) throw new Error('no matching expired external effect to reconcile');
      return { ...metadata, phase: 'reconciled', id: existing.id };
    }
    if ('candidate' in event) {
      const [retired] =
        await tx`select build from retainer_deploy.retired_builds where build = ${event.candidate}`;
      if (retired) throw new Error('a retired writer build cannot be admitted');
    }
    if (event.command === 'writer-admission-enroll') {
      if (state.generation !== event.generation || state.deployment)
        throw new Error('writer admission generation changed');
      await tx`update retainer_deploy.admission set builds = array_append(builds, ${event.candidate})
        where singleton and not ${event.candidate} = any(builds)`;
      return { ...metadata, phase: 'open', generation: state.generation };
    }
    if (event.command === 'writer-admission-close') {
      const { ownership } = event;
      if (owns(state, ownership))
        return { ...metadata, phase: 'closed', ...ownership, closedAt: state.closed_at };
      if (state.deployment || state.generation !== ownership.generation)
        throw new Error('writer admission ownership changed');
      if (
        event.expectedBuilds.length !== state.builds.length ||
        state.builds.some((build) => !event.expectedBuilds.includes(build))
      )
        throw new Error('writer admission coverage changed');
      if (!event.timed && state.builds.includes(ownership.candidate))
        throw new Error('an admitted candidate requires a timed drain');
      if (await unsettled(tx)) return { ...metadata, phase: 'busy' };
      await tx`delete from retainer_deploy.writer_leases where effect is null and until <= clock_timestamp()`;
      const [closed] = await tx<{ closed_at: Date }[]>`
        update retainer_deploy.admission set deployment = ${ownership.deployment},
          candidate = ${ownership.candidate}, migrated = false, timed = ${event.timed}, closed_at = clock_timestamp()
        where singleton returning closed_at`;
      return { ...metadata, phase: 'closed', ...ownership, closedAt: closed?.closed_at };
    }
    const { candidate, ownership } = event;
    if (
      state.generation &&
      (!ownership ||
        !owns(state, ownership) ||
        !state.migrated ||
        candidate !== ownership.candidate)
    )
      throw new Error('writer admission cannot open before the owned migration completes');
    if (state.generation && !state.timed && state.builds.includes(candidate))
      throw new Error('an admitted candidate requires a timed drain');
    if (await unsettled(tx)) return { ...metadata, phase: 'busy' };
    await tx`insert into retainer_deploy.retired_builds (build)
      select build from unnest(${state.builds}::text[]) as build where build <> ${candidate}
      on conflict do nothing`;
    const generation = randomUUID();
    await tx`update retainer_deploy.admission set generation = ${generation}, builds = array[${candidate}]::text[],
      deployment = null, candidate = null, migrated = false, timed = false, closed_at = null where singleton`;
    return { ...metadata, phase: 'open', generation };
  });
}

/** Reacquired on the same transaction that runs DDL and updates the journal. */
export async function requireMigrationOwnership(
  tx: Tx,
  ownership: Ownership | undefined,
  build: string | undefined,
) {
  const state = await lookup(tx);
  if (!state && !ownership) return undefined;
  if (ownership && (!state || !owns(state, ownership) || ownership.candidate !== build))
    throw new Error('migration requires closed writer admission and verified deployment ownership');
  const [lock] = await tx`select pg_try_advisory_xact_lock(${WRITER_ADMISSION_LOCK}) as held`;
  if (lock?.held !== true) {
    if (state?.generation && !ownership)
      throw new Error(
        'migration requires closed writer admission and verified deployment ownership',
      );
    throw new Error('writer admission ownership is busy; retry migration');
  }
  const lockedState = await lookup(tx);
  if (!lockedState?.generation && !ownership) return undefined;
  if (!lockedState || !ownership || !owns(lockedState, ownership) || ownership.candidate !== build)
    throw new Error('migration requires closed writer admission and verified deployment ownership');
  if (await unsettled(tx)) throw new Error('unsettled writer leases prevent migration');
  const [row] = await tx<{ permitted_at: Date }[]>`
    select set_config('retainer.migration_owner', ${ownership.deployment}, true), clock_timestamp() as permitted_at`;
  if (!row || !lockedState.closed_at) throw new Error('missing admission timestamps');
  return { closedAt: lockedState.closed_at, permittedAt: row.permitted_at };
}
