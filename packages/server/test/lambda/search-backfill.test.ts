import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

it('resumes a bounded search backfill, skips locked records and scopes writes to one workspace', async () => {
  const [target, other] = await Promise.all([
    createWorkspace(db.owner, { name: 'Search backfill', template: 'starter' }),
    createWorkspace(db.owner, { name: 'Concurrent workspace', template: 'starter' }),
  ]);
  const build = 'a'.repeat(40);
  const config = loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' });
  const ops = createOpsHandler(config, build);
  const caller = (workspaceId: string): Caller => ({
    workspaceId,
    actor: { type: 'agent', id: 'fixture' },
    scopes: ['admin'],
  });
  const addRecord = (workspaceId: string, name: string) =>
    createRecord(db.owner, caller(workspaceId), 'person', { name });
  const [first, second, outside] = await Promise.all([
    addRecord(target.id, 'First'),
    addRecord(target.id, 'Second'),
    addRecord(other.id, 'Outside'),
  ]);
  const ids = [first.record.id, second.record.id, outside.record.id];
  const snapshots = () =>
    db.owner`select id, search::text from records where id = any(${ids}::uuid[]) order by id`;
  const before = await snapshots();
  await db.owner`update records set search = null where id = any(${ids}::uuid[])`;
  const open = await ops({ command: 'writer-admission-open', protocol: 1, candidate: build });
  const generation = 'generation' in open ? open.generation : undefined;
  if (!generation) throw new Error('Expected an open writer generation');
  const command = {
    command: 'backfill-search-text',
    protocol: 1,
    workspaceId: target.id,
    batch: 1,
  };
  await expect(createOpsHandler(config, 'b'.repeat(40))(command)).rejects.toThrow('not admitted');

  const writer = db.connect({ role: RUNTIME_ROLE, writerBuild: build });
  await db.owner.begin(async (tx) => {
    await tx`select id from records where id = ${first.record.id} for update`;
    const [batch, write, targetWrite] = await Promise.all([
      ops(command),
      createRecord(writer, caller(other.id), 'person', { name: 'Concurrent write' }),
      createRecord(writer, caller(target.id), 'person', { name: 'Concurrent target write' }),
    ]);
    expect(batch).toMatchObject({ rebuilt: 1, pending: true });
    expect(write.record.id).toBeTruthy();
    expect(targetWrite.record.id).toBeTruthy();
  });

  await expect(ops(command)).resolves.toMatchObject({ rebuilt: 1, pending: false });
  await expect(ops(command)).resolves.toMatchObject({ rebuilt: 0, pending: false });
  expect(await snapshots()).toEqual(
    before.map((record) =>
      record.id === outside.record.id ? { ...record, search: null } : record,
    ),
  );
  await expect(
    ops({
      command: 'writer-admission-close',
      protocol: 1,
      ownership: { generation, deployment: randomUUID(), candidate: build },
      expectedBuilds: [build],
      timed: true,
    }),
  ).resolves.toMatchObject({ phase: 'closed' });
  await expect(ops(command)).rejects.toThrow('not admitted');
});
