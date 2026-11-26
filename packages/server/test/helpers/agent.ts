import { randomUUID } from 'node:crypto';
import { createMastraStore, serverAddedTextPart } from '@retainer/agent';
import type { Sql } from '../../src/db/client.js';

export const RUNTIME_SECRET = 'agent-runtime-secret-0123456789abcdef0123456789';

/**
 * Each Mastra table and the columns that tie its rows to a session or a run
 * (agent spec §5.4). A table in `pg_tables` that isn't listed here fails the
 * erasure tests, so a Mastra upgrade that adds one can't slip past them.
 */
export const MASTRA_KEYS: Record<string, { session?: string[]; run?: string[] }> = {
  mastra_threads: { session: ['id', 'resourceId'] },
  mastra_messages: { session: ['thread_id', 'resourceId'] },
  mastra_resources: { session: ['id'] },
  mastra_observational_memory: { session: ['threadId', 'resourceId'] },
  mastra_memory_run_fences: { run: ['runId'] },
  mastra_workflow_snapshot: { session: ['resourceId'], run: ['run_id'] },
  mastra_workflow_runs: { session: ['resourceId', 'threadId'], run: ['run_id'] },
  mastra_workflow_run_entries: { run: ['run_id'] },
  mastra_workflow_run_owners: { run: ['runId'] },
};

/** Writes a chat's history through Mastra's own store: a thread and one message. */
export async function saveChatHistory(url: string, sessionId: string, text: string) {
  const handle = createMastraStore({ connectionString: url, max: 1 });
  try {
    const memory = await handle.store.getStore('memory');
    if (!memory) throw new Error('no memory domain');
    const now = new Date();
    await memory.saveThread({
      thread: { id: sessionId, resourceId: sessionId, title: '', createdAt: now, updatedAt: now },
    });
    await memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          threadId: sessionId,
          resourceId: sessionId,
          createdAt: now,
          content: {
            format: 2,
            parts: [{ type: 'text', text }, serverAddedTextPart('Today is Thursday.')],
          },
        },
      ],
    });
  } finally {
    await handle.close();
  }
}

/** A row in every Mastra table for a session and one of its runs, as the owner. */
export async function seedMastra(owner: Sql, sessionId: string, runId: string) {
  const s = sessionId;
  const r = runId;
  await owner.unsafe(
    `insert into mastra.mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       values ($1, $1, '', now(), now()) on conflict do nothing;`,
    [s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
       values ($1, $2, '{}', 'user', 'v2', now(), $2)`,
    [randomUUID(), s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_resources (id, "createdAt", "updatedAt") values ($1, now(), now())
       on conflict do nothing`,
    [s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_observational_memory (id, "lookupKey", scope, "resourceId", "threadId",
       "activeObservations", "originType", config, "generationCount", "pendingMessageTokens",
       "totalTokensObserved", "observationTokenCount", "isObserving", "isReflecting",
       "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens", "createdAt", "updatedAt")
     values ($1, $1, 'thread', $2, $2, '', 'x', '{}', 0, 0, 0, 0, false, false, false, false, 0, now(), now())`,
    [randomUUID(), s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_memory_run_fences ("runId", generation, "ownerId") values ($1, 1, 'x')`,
    [r],
  );
  await owner.unsafe(
    `insert into mastra.mastra_workflow_snapshot (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
       values ('agentic-loop', $1, $2, '{}', now(), now())`,
    [r, s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_workflow_runs (workflow_name, run_id, "resourceId", "threadId", status, header,
       "lastSeq", "startStateSeq", "stateShared", "stateSeq", "statePatchCount", "statePatchBytes",
       "runToken", "createdAt", "updatedAt")
     values ('agentic-loop', $1, $2, $2, 'running', '{}', 0, 0, false, 0, 0, 0, 'x', now(), now())`,
    [r, s],
  );
  await owner.unsafe(
    `insert into mastra.mastra_workflow_run_entries (workflow_name, run_id, seq, kind) values ('agentic-loop', $1, 1, 'x')`,
    [r],
  );
  await owner.unsafe(
    `insert into mastra.mastra_workflow_run_owners ("runId", generation, "ownerId", "updatedAt") values ($1, 1, 'x', 0)`,
    [r],
  );
}

/**
 * Rows left in every table of the `mastra` schema for these sessions and runs,
 * by table. Lists the tables from `pg_tables`; an unknown table throws.
 */
export async function mastraRows(owner: Sql, sessions: string[], runs: string[]) {
  const tables = await owner<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'mastra' order by 1`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const keys = MASTRA_KEYS[tablename];
    if (!keys) throw new Error(`mastra.${tablename} has no erasure key in the test`);
    const where = [
      ...(keys.session ?? []).map((column) => `"${column}" = any($1::text[])`),
      ...(keys.run ?? []).map((column) => `"${column}" = any($2::text[])`),
    ].join(' or ');
    // Both parameters are typed even where a table uses only one.
    const [row] = await owner.unsafe<{ count: number }[]>(
      `select count(*)::int as count from mastra."${tablename}" where $1::text[] is not null and $2::text[] is not null and (${where})`,
      [sessions, runs] as never,
    );
    counts[tablename] = row?.count ?? 0;
  }
  return counts;
}

export const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);
