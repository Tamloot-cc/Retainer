import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { maintainAgents } from '../../src/agent-sessions/maintenance.js';
import { CONTROL_ROLE, EXECUTOR_ROLE, MASTRA_ROLE } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { purgeDeletedWorkspaces, restoreWorkspace } from '../../src/workspaces/deletion.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { MASTRA_KEYS, mastraRows, seedMastra, total } from '../helpers/agent.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
/** A seeded session has one row in each Mastra table. */
const EVERY_TABLE = Object.keys(MASTRA_KEYS).length;

/** A session with one turn and a row in every Mastra table, written as the owner. */
async function session(
  workspaceId: string,
  options: { kind?: 'chat' | 'task'; lastActive?: string; running?: boolean } = {},
) {
  const id = randomUUID();
  const runId = randomUUID();
  await db.owner`
    insert into agent_sessions (id, workspace_id, kind, owner, tools, system_blocks, limits, last_active_at)
    values (${id}, ${workspaceId}, ${options.kind ?? 'chat'}, 'key:test', '[]', '[]', '{}',
      now() - ${options.lastActive ?? '0 seconds'}::interval)`;
  await db.owner`
    insert into agent_turns (workspace_id, session_id, generation, status, run_id, token_hash, access, deadline, stopped_at)
    values (${workspaceId}, ${id}, 1, ${options.running ? 'running' : 'completed'}, ${runId}, 'x',
      ${db.owner.json({ kind: 'key', hash: 'a'.repeat(64) })},
      now() + interval '10 minutes', ${options.running ? null : new Date()})`;
  await seedMastra(db.owner, id, runId);
  return { id, runId };
}

const rowsOf = async (...sessions: { id: string; runId: string }[]) =>
  total(
    await mastraRows(
      db.owner,
      sessions.map((s) => s.id),
      sessions.map((s) => s.runId),
    ),
  );

const workspace = (name: string) => createWorkspace(db.owner, { name });

describe('the mastra role', () => {
  it('reaches the mastra schema and nothing in public', async () => {
    const mastra = db.connect({ role: MASTRA_ROLE, max: 1 });
    try {
      await expect(mastra`select 1 from public.records limit 1`).rejects.toThrow(
        /permission denied/,
      );
      await expect(mastra`select 1 from public.agent_sessions limit 1`).rejects.toThrow(
        /permission denied/,
      );
      await expect(mastra`select 1 from public.workspaces limit 1`).rejects.toThrow(
        /permission denied/,
      );
      expect(await mastra`select count(*) from mastra.mastra_messages`).toHaveLength(1);
      await expect(mastra`create table mastra.nope (id int)`).rejects.toThrow(/permission denied/);
      await expect(mastra`select retainer_erase_agent_content(null, null)`).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await mastra.end();
    }
    const memberships = await db.owner`
      select r.rolname from pg_auth_members m
      join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
      where u.rolname = ${MASTRA_ROLE}`;
    expect(memberships).toEqual([]);
  });

  it('gives the API and control roles no direct grant on mastra tables', async () => {
    const grants = await db.owner<{ grantee: string }[]>`
      select distinct grantee from information_schema.role_table_grants
      where table_schema = 'mastra' and grantee in (${RUNTIME_ROLE}, ${CONTROL_ROLE}, ${EXECUTOR_ROLE})`;
    expect(grants).toEqual([]);
  });
});

describe('the erasure function', () => {
  it('erases only within the scoped workspace', async () => {
    const a = await workspace('Erase A');
    const b = await workspace('Erase B');
    const mine = await session(a.id);
    const theirs = await session(b.id);
    const app = db.connect({ role: RUNTIME_ROLE, max: 1 });
    try {
      // Scoped to A, asking for A's and B's sessions: only A's go.
      const erased = await inWorkspace(app, a.id, async (tx) => {
        const [row] = await tx<{ n: number }[]>`
          select retainer_erase_agent_content(${a.id}::uuid, ${[mine.id, theirs.id]}::uuid[]) as n`;
        return row?.n;
      });
      expect(erased).toBeGreaterThan(0);
      // Asking for B while scoped to A is refused.
      await expect(
        inWorkspace(
          app,
          a.id,
          (tx) => tx`select retainer_erase_agent_content(${b.id}::uuid, null)`,
        ),
      ).rejects.toThrow();
    } finally {
      await app.end();
    }
    expect(await rowsOf(mine)).toBe(0);
    expect(await rowsOf(theirs)).toBeGreaterThan(0);
  });
});

describe('the workspace purge', () => {
  it('erases its own Mastra rows and leaves another workspace’s', async () => {
    const doomed = await workspace('Purge me');
    const kept = await workspace('Keep me');
    const gone = await session(doomed.id);
    const stays = await session(kept.id);
    await db.owner`update workspaces set deletion_scheduled_at = now() - interval '8 days' where id = ${doomed.id}`;
    const control = db.connect({ role: CONTROL_ROLE, max: 2 });
    try {
      expect((await purgeDeletedWorkspaces(control)).purged).toBe(1);
    } finally {
      await control.end();
    }
    expect(await rowsOf(gone)).toBe(0);
    expect(await rowsOf(stays)).toBeGreaterThan(0);
  });

  /**
   * A restore racing the purge, in both orders (concurrent). Both queue on
   * the workspace row, held by a third connection, in a known order.
   */
  for (const first of ['purge', 'restore'] as const) {
    it(`never leaves a restored workspace without its chats when the ${first} goes first`, async () => {
      const raced = await workspace(`Race ${first}`);
      const chat = await session(raced.id);
      await db.owner`update workspaces set deletion_scheduled_at = now() - interval '8 days' where id = ${raced.id}`;
      const control = db.connect({ role: CONTROL_ROLE, max: 2 });
      const holder = await db.owner.reserve();
      // Waiters on the workspace row, which the holder keeps share-locked: the
      // purge's extension check passes it, and its delete waits; a restore's
      // update waits. Each starts only once the one before it waits.
      const waiting = (count: number) =>
        expect
          .poll(async () => {
            const [row] = await db.owner<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`;
            return row?.n;
          })
          .toBe(count);
      let purge: Promise<unknown> | undefined;
      let restore: Promise<unknown> | undefined;
      try {
        await holder`begin`;
        await holder`select id from workspaces where id = ${raced.id} for share`;
        const startPurge = async (count: number) => {
          purge = purgeDeletedWorkspaces(control);
          await waiting(count);
        };
        const startRestore = async (count: number) => {
          restore = restoreWorkspace(db.owner, raced.id).catch((error: unknown) => error);
          await waiting(count);
        };
        if (first === 'purge') {
          await startPurge(1);
          await startRestore(2);
        } else {
          await startRestore(1);
          await startPurge(2);
        }
      } finally {
        await holder`commit`;
        holder.release();
      }
      const [purged, restored] = await Promise.all([purge, restore]);
      await control.end();
      const [row] = await db.owner<{ deletion_scheduled_at: Date | null }[]>`
        select deletion_scheduled_at from workspaces where id = ${raced.id}`;
      if (first === 'purge') {
        expect(purged).toMatchObject({ purged: 1 });
        expect(restored).toBeInstanceOf(Error);
        expect(row).toBeUndefined();
        expect(await rowsOf(chat)).toBe(0);
      } else {
        expect(purged).toMatchObject({ purged: 0 });
        expect(row?.deletion_scheduled_at).toBeNull();
        expect(await rowsOf(chat)).toBe(EVERY_TABLE);
        const [sessionRow] = await db.owner`select 1 from agent_sessions where id = ${chat.id}`;
        expect(sessionRow).toBeDefined();
      }
    });
  }
});

describe('maintenance', () => {
  it('erases an expired task, times out dead turns, and keeps the rest', async () => {
    const w = await workspace('Maintenance');
    const expired = await session(w.id, { kind: 'task', lastActive: '8 days' });
    const liveTask = await session(w.id, { kind: 'task' });
    const oldChat = await session(w.id, { kind: 'chat', lastActive: '30 days' });
    const dead = await session(w.id, { kind: 'chat', running: true });
    await db.owner`update agent_turns set deadline = now() - interval '5 minutes' where session_id = ${dead.id}`;
    await db.owner`
      insert into agent_stream_tokens (workspace_id, session_id, token_hash, access, expires_at)
      values (${w.id}, ${oldChat.id}, 'x', '{}', now() - interval '1 minute')`;
    const app = db.connect({ role: RUNTIME_ROLE, max: 2 });
    const executor = db.connect({ role: EXECUTOR_ROLE, max: 1 });
    try {
      await maintainAgents(app, executor, Date.now() + 30_000);
    } finally {
      await app.end();
      await executor.end();
    }
    expect(await rowsOf(expired)).toBe(0);
    expect(await db.owner`select 1 from agent_sessions where id = ${expired.id}`).toHaveLength(0);
    expect(await rowsOf(liveTask)).toBe(EVERY_TABLE);
    expect(await rowsOf(oldChat)).toBe(EVERY_TABLE);
    const [turn] = await db.owner<{ status: string }[]>`
      select status from agent_turns where session_id = ${dead.id}`;
    expect(turn?.status).toBe('timed_out');
    expect(
      await db.owner`select 1 from agent_stream_tokens where session_id = ${oldChat.id}`,
    ).toHaveLength(0);
  });

  it('removes a chat deleted mid-turn once its runtime has stopped, erasing a late step', async () => {
    const w = await workspace('Deleted');
    const stopped = await session(w.id, { running: true });
    const stillRunning = await session(w.id, { running: true });
    for (const chat of [stopped, stillRunning])
      await db.owner`update agent_sessions set status = 'deleted', title = '' where id = ${chat.id}`;
    // The first runtime saved one more step after the erasure, then stopped.
    await db.owner`
      update agent_turns set status = 'cancelled', stopped_at = now() where session_id = ${stopped.id}`;
    const app = db.connect({ role: RUNTIME_ROLE, max: 2 });
    const executor = db.connect({ role: EXECUTOR_ROLE, max: 1 });
    try {
      await maintainAgents(app, executor, Date.now() + 30_000);
    } finally {
      await app.end();
      await executor.end();
    }
    expect(await rowsOf(stopped)).toBe(0);
    expect(await db.owner`select 1 from agent_sessions where id = ${stopped.id}`).toHaveLength(0);
    // A runtime still inside its deadline keeps the row, so its late report counts.
    expect(await db.owner`select 1 from agent_sessions where id = ${stillRunning.id}`).toHaveLength(
      1,
    );
  });

  it('sweeps Mastra rows that belong to no session, such as a step saved after its erasure', async () => {
    const w = await workspace('Orphans');
    const kept = await session(w.id);
    const orphan = { id: randomUUID(), runId: randomUUID() };
    await seedMastra(db.owner, orphan.id, orphan.runId);
    const app = db.connect({ role: RUNTIME_ROLE, max: 1 });
    try {
      await app`select retainer_sweep_agent_orphans()`;
    } finally {
      await app.end();
    }
    expect(await rowsOf(orphan)).toBe(0);
    expect(await rowsOf(kept)).toBe(EVERY_TABLE);
  });
});
