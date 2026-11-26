import { Memory } from '@mastra/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readChatMessages } from '../src/history.js';
import { serverAddedTextPart } from '../src/parts.js';
import { createMastraStore, type MastraStoreHandle } from '../src/store.js';
import { createMastraTestDatabase, type MastraTestDatabase } from './db.js';

let db: MastraTestDatabase;
let handle: MastraStoreHandle;

beforeAll(async () => {
  db = await createMastraTestDatabase();
  handle = createMastraStore({ connectionString: db.mastraUrl });
});
afterAll(async () => {
  await handle?.close();
  await db?.drop();
});

describe('the Mastra store', () => {
  it('creates only the memory and workflows tables, in the mastra schema', async () => {
    const { rows } = await db.query(
      `select tablename from pg_tables where schemaname = 'mastra' order by 1`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'mastra_memory_run_fences',
      'mastra_messages',
      'mastra_observational_memory',
      'mastra_resources',
      'mastra_threads',
      'mastra_workflow_run_entries',
      'mastra_workflow_run_owners',
      'mastra_workflow_runs',
      'mastra_workflow_snapshot',
    ]);
  });

  it('runs as a role that reaches only the mastra schema and does no DDL', async () => {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: db.mastraUrl });
    await client.connect();
    try {
      await expect(client.query('create table mastra.nope (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('create table public.nope (id int)')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.end();
    }
    // The store itself never runs init at runtime (disableInit).
    expect(handle.store.disableInit).toBe(true);
  });

  it('saves and reads a chat, leaving out the server-added parts', async () => {
    const memory = new Memory({
      storage: handle.store,
      options: {
        lastMessages: Number.MAX_SAFE_INTEGER,
        semanticRecall: false,
        generateTitle: false,
      },
    });
    const id = crypto.randomUUID();
    await memory.createThread({ threadId: id, resourceId: id, title: 'Hello' });
    await memory.saveMessages({
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          threadId: id,
          resourceId: id,
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'Hello there' }, serverAddedTextPart('Today is …')],
          },
        },
      ],
    });
    const messages = (await readChatMessages(handle, id)) as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual([
      'Hello there',
    ]);
  });
});
