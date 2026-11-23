import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createApiKey } from '../../src/auth/keys.js';
import { loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const previous = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const index = 'CREATE INDEX "restricted_fixture" ON "public"."records" USING btree ("label");';
const rewrite = 'ALTER TABLE "records" ALTER COLUMN "label" TYPE integer USING length("label");';
const independentTable = `CREATE TABLE "public"."restricted_fixture" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);`;
const dirname = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const sqlFile = 'restricted_fixture.sql';
let folder: string | undefined;
let db: TestDatabase | undefined;

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  await db?.drop();
});

async function fixture(sql: string) {
  const database = await createTestDatabase();
  db = database;
  const input = await mkdtemp(join(tmpdir(), 'retainer-restricted-index-'));
  folder = input;
  await mkdir(join(input, 'meta'));
  await Promise.all(
    (await readdir(dirname))
      .filter((entry) => entry.endsWith('.sql'))
      .map((entry) => copyFile(join(dirname, entry), join(input, entry))),
  );
  const path = join('meta', '_journal.json');
  const journal = JSON.parse(await readFile(join(dirname, path), 'utf8'));
  const last = journal.entries.at(-1);
  journal.entries.push({
    ...last,
    idx: last.idx + 1,
    when: last.when + 1,
    tag: 'restricted_fixture',
  });
  await writeFile(join(input, path), JSON.stringify(journal));
  await writeFile(join(input, sqlFile), sql);

  const config = loadConfig({ DATABASE_URL: database.url, LOG_LEVEL: 'error' });
  const ops = createOpsHandler(config, candidate, input);
  async function ownership() {
    const old = createOpsHandler(config, previous);
    const open = await old({ command: 'writer-admission-open', protocol: 1, candidate: previous });
    if (!('generation' in open) || !open.generation) throw new Error('Missing writer generation');
    return { generation: open.generation, deployment: randomUUID(), candidate };
  }
  async function close(proof: Awaited<ReturnType<typeof ownership>>) {
    await expect(
      ops({
        command: 'writer-admission-close',
        protocol: 1,
        ownership: proof,
        expectedBuilds: [previous],
        timed: false,
      }),
    ).resolves.toMatchObject({ phase: 'closed' });
  }
  const status = () => ops({ command: 'restricted-index-status', protocol: 1 });
  const relation = async () => {
    const [row] = await database.owner`select to_regclass('public.restricted_fixture') as name`;
    return row?.name;
  };
  return { database, input, status, ops, ownership, close, relation };
}

it('adds an independent table while the serving generation stays open', async () => {
  const { database, ops, ownership, relation } = await fixture(independentTable);
  const workspace = await createWorkspace(database.owner, {
    name: 'Online migration fixture',
    template: 'starter',
  });
  const { key } = await createApiKey(database.owner, {
    workspace: workspace.id,
    name: 'Writer',
    actor: { type: 'agent', id: 'writer' },
    scopes: ['read', 'write'],
  });
  const old = createApp({ sql: database.connect({ role: RUNTIME_ROLE, writerBuild: previous }) });
  await ownership();
  const status = await ops({ command: 'online-table-status', protocol: 1 });
  if (status.command !== 'online-table-status' || !status.journal)
    throw new Error('Expected an approved table journal');
  const request = {
    command: 'migrate-online-tables',
    protocol: 1,
    servingBuild: previous,
    journal: status.journal,
  } as const;
  await expect(ops({ ...request, servingBuild: candidate })).rejects.toThrow(
    'verified serving build',
  );
  await expect(relation()).resolves.toBeNull();
  await database.owner.begin(async (tx) => {
    await tx`lock table drizzle.__drizzle_migrations in access exclusive mode`;
    await expect(ops(request)).rejects.toMatchObject({ code: '55P03' });
  });
  await expect(relation()).resolves.toBeNull();
  const [migration, write] = await Promise.all([
    ops(request),
    old.request('/v1/objects/person/records', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { name: 'Written through the old build' } }),
    }),
  ]);
  expect(migration).toMatchObject({ command: request.command, writerBuild: candidate });
  expect(write.status).toBe(201);
  await expect(relation()).resolves.not.toBeNull();
  await expect(ops(request)).rejects.toThrow('no longer matches the approved plan');
});

it('excludes indexes from the online table path', async () => {
  const { ops } = await fixture(index);
  await expect(ops({ command: 'online-table-status', protocol: 1 })).resolves.toMatchObject({
    journal: null,
  });
});

it('requires ownership and the same journal on the transaction applying the indexes', async () => {
  const { status, ops, ownership, close, relation, input } = await fixture(index);
  const plan = await status();
  if (plan.command !== 'restricted-index-status' || !plan.journal)
    throw new Error('Expected an ordinary index to qualify');

  const journal = plan.journal;
  const proof = await ownership();
  const migrate = () =>
    ops({
      command: 'migrate-restricted-indexes',
      protocol: 1,
      writerAdmission: proof,
      journal,
    });
  await expect(migrate()).rejects.toThrow('closed writer admission');
  await close(proof);
  await writeFile(join(input, sqlFile), index.replace('"label"', '"id"'));
  await expect(migrate()).rejects.toThrow('no longer matches');
  expect(await relation()).toBeNull();
  await writeFile(join(input, sqlFile), index);

  expect(await migrate()).toMatchObject({
    command: 'migrate-restricted-indexes',
    followUpReasons: [],
  });
  expect(await relation()).toBe('restricted_fixture');
  expect(await status()).toMatchObject({ journal: null });
  await expect(
    ops({ command: 'writer-admission-open', protocol: 1, candidate, ownership: proof }),
  ).resolves.toMatchObject({ phase: 'open' });
});

it('rejects a blocking table rewrite before exposing a plan', async () => {
  const { status } = await fixture(rewrite);
  expect(await status()).toMatchObject({ journal: null });
});

it('leaves admission closed after compatible SQL when a workspace upgrade is pending', async () => {
  const { database, status, ops, ownership, close, relation } = await fixture(index);
  const ws = await createWorkspace(database.owner, {
    name: 'Pending upgrade',
    template: 'starter',
  });
  await database.owner`update workspaces set definitions_digest = null where id = ${ws.id}`;
  const plan = await status();
  if (plan.command !== 'restricted-index-status' || !plan.journal)
    throw new Error('Expected a plan for the index phase');
  const proof = await ownership();
  await close(proof);
  expect(
    await ops({
      command: 'migrate-restricted-indexes',
      protocol: 1,
      writerAdmission: proof,
      journal: plan.journal,
    }),
  ).toMatchObject({ followUpReasons: ['definitions'] });
  expect(await relation()).toBe('restricted_fixture');
  await expect(
    ops({ command: 'writer-admission-open', protocol: 1, candidate, ownership: proof }),
  ).rejects.toThrow('before the owned migration completes');
});

it('bounds DDL lock acquisition on the owned connection and leaves its journal intact', async () => {
  const { database, status, ops, ownership, close, relation } = await fixture(index);
  const plan = await status();
  if (plan.command !== 'restricted-index-status' || !plan.journal)
    throw new Error('Expected an ordinary index to qualify');
  const journal = plan.journal;
  const proof = await ownership();
  await close(proof);
  await database.owner.begin(async (tx) => {
    await tx`lock table public.records in access exclusive mode`;
    await expect(
      ops({
        command: 'migrate-restricted-indexes',
        protocol: 1,
        writerAdmission: proof,
        journal,
      }),
    ).rejects.toMatchObject({ code: '55P03' });
  });
  expect(await relation()).toBeNull();
  expect(await status()).toMatchObject({ journal });
});

it('uses the maintenance response without a replay guarantee if a write reaches the database fence', async () => {
  const { database, ownership, close } = await fixture(index);
  const workspace = await createWorkspace(database.owner, {
    name: 'Write fixture',
    template: 'starter',
  });
  const { key } = await createApiKey(database.owner, {
    workspace: workspace.id,
    name: 'Writer',
    actor: { type: 'agent', id: 'writer' },
    scopes: ['read', 'write'],
  });
  const old = createApp({ sql: database.connect({ role: RUNTIME_ROLE, writerBuild: previous }) });
  await close(await ownership());
  const response = await old.request('/v1/objects/person/records', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: { name: 'Rejected' } }),
  });
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('5');
  expect(response.headers.has('x-retainer-maintenance')).toBe(false);
  expect(await response.json()).toMatchObject({ error: { code: 'maintenance' } });
  expect(
    await database.owner`select id from records where workspace_id = ${workspace.id} and label = 'Rejected'`,
  ).toHaveLength(0);
});
