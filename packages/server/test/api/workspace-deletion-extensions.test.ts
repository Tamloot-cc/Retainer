import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { CONTROL_ROLE } from '../../src/config.js';
import type { Sql } from '../../src/db/client.js';
import { lockSchemaExclusive, type Tx } from '../../src/db/tx.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { purgeDeletedWorkspaces, restoreWorkspace } from '../../src/workspaces/deletion.js';
import { createOrganization, setOrganizationMember } from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, startAccountsApp } from '../helpers/accounts.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

// Deleting a workspace uninstalls its extensions first (extensions spec 7,
// review R7): hosted installations run their provider cleanup, standalone ones
// lose their grant, and the hard delete waits for cleanup or its deadline.

const db = useTestDatabase();
const setupId = randomUUID(),
  cleanupId = randomUUID(),
  jobId = randomUUID();
const fn = (universalId: string, name: string, kind: 'install' | 'uninstall' | 'job') => ({
  universalId,
  name,
  description: 'Deletion fixture',
  handlerDigest: 'b'.repeat(64),
  timeoutSeconds: 120,
  trigger: { kind },
  inputSchema: { type: 'object' as const, additionalProperties: false as const },
});
// Optional, so installs need no staged value; functions declare no list, so
// their runs keep the first contract's access to every secret setting.
const settings = {
  apiKey: { type: 'string', label: 'API key', secret: true, required: false, reconnect: false },
} as const;
const hosted = extensionFixture({
  scopes: ['read', 'write'],
  settings,
  functions: [
    fn(setupId, 'setup', 'install'),
    fn(cleanupId, 'cleanup', 'uninstall'),
    fn(jobId, 'sync', 'job'),
  ],
});
const second = extensionFixture({
  scopes: ['read'],
  settings,
  functions: [fn(randomUUID(), 'cleanup', 'uninstall')],
});
const standalone = extensionFixture({ execution: 'standalone', scopes: ['read', 'write'] });
const catalog = new ExtensionCatalog(
  [hosted, second, standalone].map((manifest) => ({
    manifest,
    actorCeiling: 'integration' as const,
    runtimeEnabled: true,
  })),
);

let accounts: AccountsTestApp, t: TestApp, tokens: RunTokens;
const queue = () => new ExtensionQueue(t.sql, catalog.runtime);
const executor = () => db.connect({ role: 'retainer_executor' });
const control = () => db.connect({ role: CONTROL_ROLE, max: 1 });

beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  accounts = startAccountsApp(db, { extensionCatalog: catalog });
  t = startTestApp(db, {
    extensionCatalog: catalog,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
  });
});

async function setup() {
  const email = `owner-${randomUUID().slice(0, 8)}@delete.test`;
  const owner = await accounts.signIn({ email, name: 'Owner' });
  const organization = (await createOrganization(db.owner, { name: 'Ext Co' })).id;
  const name = `Doomed ${randomUUID().slice(0, 8)}`;
  const workspace = await createWorkspace(db.owner, {
    name,
    slug: `ext-del-${randomUUID().slice(0, 8)}`,
    template: 'sales',
    organization,
  });
  await setOrganizationMember(db.owner, { organization, email, role: 'owner' });
  const { key } = await createApiKey(db.owner, {
    workspace: workspace.id,
    name: 'admin',
    actor: { type: 'user', id: 'admin' },
    scopes: ['admin'],
  });
  return { owner, workspace: workspace.id, name, key };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function install(s: Setup, manifest = hosted) {
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: s.key, body: input });
  expect(preview.status).toBe(200);
  const res = await t.request('/v1/extensions', {
    key: s.key,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  if (manifest.execution === 'hosted') {
    await queue().complete(await claim(s.workspace, id, 'install'), { status: 'succeeded' });
  }
  expect((await state(id))?.state).toBe('active');
  return id;
}

async function claim(workspace: string, id: string, kind: string) {
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind=${kind} and status='queued' order by id limit 1`;
  if (!job) throw new Error(`no queued ${kind} job`);
  const claimed = await queue().claim(workspace, job.id, randomUUID());
  if (!claimed) throw new Error('claim failed');
  return claimed;
}

const state = async (id: string) =>
  (
    await db.owner<
      {
        state: string;
        generation: number;
        grant_generation: number;
        last_error: string | null;
        deadline_hours: number | null;
      }[]
    >`select state,generation,grant_generation,last_error,
      (extract(epoch from cleanup_deadline-now())/3600)::float8 as deadline_hours
      from extension_installations where id=${id}`
  )[0];

const jobs = (id: string) =>
  db.owner<{ trigger_kind: string; status: string; generation: number }[]>`
    select trigger_kind,status,generation from extension_jobs where installation_id=${id} order by created_at,id`;

const remove = (s: Setup) =>
  accounts.account(`/account/workspaces/${s.workspace}`, {
    cookie: s.owner.cookie,
    method: 'DELETE',
    body: { name: s.name },
  });

const due = async () =>
  (
    await executor()<{ job_id: string }[]>`
      select job_id from retainer_extension_jobs_due(1000,${catalog.runtime.identity})`
  ).map((r) => r.job_id);

const backdate = (workspace: string, days: number) =>
  db.owner`update workspaces set deletion_scheduled_at=now()-make_interval(days=>${days}) where id=${workspace}`;

const exists = async (workspace: string) =>
  (await db.owner`select 1 from workspaces where id=${workspace}`).length === 1;

async function secretAdmission(
  run: Awaited<ReturnType<typeof claim>>,
  writing: boolean,
): Promise<boolean> {
  const broker: Sql = db.connect({ role: 'retainer_secret_broker', max: 1 });
  return (await broker.begin(async (tx) => {
    await tx`select set_config('app.workspace_id',${run.workspaceId},true)`;
    const [row] = await tx<{ admitted: boolean }[]>`select retainer_admit_secret_run(
      ${run.registrationId}::uuid,${run.installationId}::uuid,${run.generation},${run.jobId}::uuid,
      ${run.owner},${run.fence}::bigint,${run.releaseDigest},${run.functionId}::uuid,'apiKey',${writing}) as admitted`;
    return row?.admitted;
  })) as boolean;
}

describe('deleting a workspace with extensions', () => {
  it('moves hosted installations to uninstalling, queues their cleanup, and revokes standalone ones', async () => {
    const s = await setup();
    const active = await install(s);
    const disabled = await install(s, second);
    expect(
      (await t.request(`/v1/extensions/${disabled}/disable`, { key: s.key, method: 'POST' }))
        .status,
    ).toBe(200);
    const app = await install(s, standalone);
    const before = { active: await state(active), app: await state(app) };
    const credential = await t.request(`/v1/extensions/${app}/keys`, {
      key: s.key,
      body: { expectedGeneration: before.app?.generation, scopes: ['read'] },
    });
    expect(credential.status).toBe(201);
    expect((await t.request('/v1/me', { key: credential.body.key })).status).toBe(200);
    await queue().enqueue(s.workspace, active, { functionId: jobId, input: {}, dedupeKey: 'work' });

    expect((await remove(s)).status).toBe(200);

    for (const id of [active, disabled]) {
      const after = await state(id);
      expect(after).toMatchObject({ state: 'uninstalling', last_error: null });
      expect(after?.deadline_hours).toBeGreaterThan(23.9);
      expect(after?.deadline_hours).toBeLessThanOrEqual(24);
      // The deleting process does not know which executables are deployed.
      expect((await jobs(id)).filter((j) => j.status === 'queued')).toEqual([]);
    }
    // The executor's maintenance pass queues the cleanup.
    await queue().maintain(executor());
    for (const id of [active, disabled]) {
      const after = await state(id);
      const queued = (await jobs(id)).filter((j) => j.status === 'queued');
      expect(queued).toEqual([
        { trigger_kind: 'uninstall', status: 'queued', generation: after?.generation },
      ]);
    }
    // Ordinary work queued before the deletion is cancelled with the old generation.
    expect((await jobs(active)).find((j) => j.trigger_kind === 'job')?.status).toBe('cancelled');
    expect((await state(active))?.generation).toBe((before.active?.generation ?? 0) + 1);
    expect((await state(active))?.grant_generation).toBe(
      (before.active?.grant_generation ?? 0) + 1,
    );
    const revoked = await state(app);
    expect(revoked).toMatchObject({ state: 'uninstalled', deadline_hours: null });
    expect(revoked?.grant_generation).toBe((before.app?.grant_generation ?? 0) + 1);
    expect(await jobs(app)).toEqual([]);

    // Restoring the workspace does not reinstall anything: the app's old
    // credential stays revoked and cleanup carries on.
    await restoreWorkspace(db.owner, s.workspace);
    expect((await t.request('/v1/me', { key: credential.body.key })).status).not.toBe(200);
    expect((await state(active))?.state).toBe('uninstalling');
    expect((await state(app))?.state).toBe('uninstalled');
  });

  it('serializes with an admin uninstall of the same installation: one cleanup job either way', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await setup();
      const id = await install(s);
      const [deleted] = await Promise.all([
        remove(s),
        t.request(`/v1/extensions/${id}/uninstall`, { key: s.key, method: 'POST' }),
      ]);
      expect(deleted.status).toBe(200);
      await queue().maintain(executor());
      const after = await state(id);
      expect(after?.state).toBe('uninstalling');
      expect(
        (await jobs(id)).filter((j) => j.trigger_kind === 'uninstall' && j.status === 'queued'),
      ).toEqual([{ trigger_kind: 'uninstall', status: 'queued', generation: after?.generation }]);
    }
  });

  it('discovers and runs cleanup in a deleting workspace, but no other work', async () => {
    const s = await setup();
    const working = await install(s);
    const leaving = await install(s, second);
    const [ordinary] = await Promise.all([
      queue().enqueue(s.workspace, working, { functionId: jobId, input: {}, dedupeKey: 'work' }),
      t.request(`/v1/extensions/${leaving}/uninstall`, { key: s.key, method: 'POST' }),
    ]);
    // A deletion flagged without the uninstall step (as before this change).
    await db.owner`update workspaces set deletion_scheduled_at=now() where id=${s.workspace}`;
    const [cleanupJob] =
      await db.owner`select id from extension_jobs where installation_id=${leaving} and trigger_kind='uninstall'`;
    const found = await due();
    expect(found).toContain(cleanupJob?.id);
    expect(found).not.toContain(ordinary.id);

    const run = await claim(s.workspace, leaving, 'uninstall');
    const token = await tokens.issue(t.sql, run, second.universalId, run.scopes);
    // The cleanup token reaches only the provider connection, never CRM data.
    expect((await t.request('/v1/objects/company/query', { key: token, body: {} })).status).toBe(
      409,
    );
    expect(await secretAdmission(run, false)).toBe(true);
    expect(await secretAdmission(run, true)).toBe(false);
    await queue().complete(run, { status: 'succeeded' });
    expect(await state(leaving)).toMatchObject({ state: 'uninstalled', last_error: null });

    // Ordinary work for the deleting workspace gets no credential.
    const sync = await claim(s.workspace, working, 'job');
    await expect(tokens.issue(t.sql, sync, hosted.universalId, sync.scopes)).rejects.toMatchObject({
      code: 'installation_disabled',
    });
  });
});

describe('removing a deleted workspace with extensions for good', () => {
  it('waits for cleanup to finish, then removes it', async () => {
    const s = await setup();
    const id = await install(s);
    expect((await remove(s)).status).toBe(200);
    await queue().maintain(executor());
    await backdate(s.workspace, 8);
    expect(await purgeDeletedWorkspaces(control())).toEqual({ purged: 0, failed: 0, waiting: 1 });
    expect(await exists(s.workspace)).toBe(true);

    await queue().complete(await claim(s.workspace, id, 'uninstall'), { status: 'succeeded' });
    expect(await purgeDeletedWorkspaces(control())).toEqual({ purged: 1, failed: 0, waiting: 0 });
    expect(await exists(s.workspace)).toBe(false);
  });

  it('removes it at the cleanup deadline when the provider stays down', async () => {
    const s = await setup();
    const id = await install(s);
    expect((await remove(s)).status).toBe(200);
    await queue().maintain(executor());
    await backdate(s.workspace, 8);
    const run = await claim(s.workspace, id, 'uninstall');
    await queue().complete(run, { status: 'retry', code: 'provider_unavailable' });
    expect((await state(id))?.state).toBe('uninstalling');
    expect((await purgeDeletedWorkspaces(control())).waiting).toBe(1);

    await db.owner`update extension_installations set cleanup_deadline=clock_timestamp()-interval '1 second' where id=${id}`;
    expect(await purgeDeletedWorkspaces(control())).toEqual({ purged: 1, failed: 0, waiting: 0 });
    expect(await exists(s.workspace)).toBe(false);
  });

  it('starts cleanup for a workspace deleted before uninstalling existed, then waits for it', async () => {
    const s = await setup();
    const id = await install(s);
    const app = await install(s, standalone);
    await backdate(s.workspace, 8);
    expect(await purgeDeletedWorkspaces(control())).toEqual({ purged: 0, failed: 0, waiting: 1 });
    expect(await exists(s.workspace)).toBe(true);
    // The purge has no catalog: both are revoked and wait for a worker.
    expect((await state(id))?.state).toBe('uninstalling');
    expect((await state(app))?.state).toBe('uninstalling');

    // Concurrent maintenance passes queue the hosted cleanup once and finish the standalone app.
    await Promise.all([queue().maintain(executor()), queue().maintain(executor())]);
    const after = await state(id);
    expect((await jobs(id)).filter((j) => j.status === 'queued')).toEqual([
      { trigger_kind: 'uninstall', status: 'queued', generation: after?.generation },
    ]);
    expect((await state(app))?.state).toBe('uninstalled');
    expect((await purgeDeletedWorkspaces(control())).waiting).toBe(1);

    await queue().complete(await claim(s.workspace, id, 'uninstall'), { status: 'succeeded' });
    expect(await purgeDeletedWorkspaces(control())).toEqual({ purged: 1, failed: 0, waiting: 0 });
    expect(await exists(s.workspace)).toBe(false);
  });
});

describe('cleanup that cannot run', () => {
  const maintenanceDue = async () =>
    (
      await executor()<{ installation_id: string }[]>`
        select installation_id from retainer_extension_maintenance_due(1000,${catalog.runtime.identity})`
    ).map((r) => r.installation_id);

  it.each([
    [
      'has no active executable',
      () => new ExtensionQueue(t.sql, catalog.runtime, undefined, new Set()),
    ],
    [
      'cannot be resolved',
      () =>
        new ExtensionQueue(
          t.sql,
          new ExtensionCatalog([{ manifest: standalone, actorCeiling: 'integration' }]).runtime,
        ),
    ],
  ])('uninstalls directly when the release %s, and is not visited again', async (_, worker) => {
    const s = await setup();
    const id = await install(s);
    expect((await remove(s)).status).toBe(200);
    expect(await maintenanceDue()).toContain(id);
    await worker().maintain(executor());
    expect(await state(id)).toMatchObject({
      state: 'uninstalled',
      last_error: 'cleanup_unavailable',
      deadline_hours: null,
    });
    expect((await jobs(id)).filter((j) => j.status === 'queued')).toEqual([]);
    expect(await maintenanceDue()).not.toContain(id);
    await backdate(s.workspace, 8);
    await purgeDeletedWorkspaces(control());
    expect(await exists(s.workspace)).toBe(false);
  });
});

describe('deleting a workspace while its schema changes', () => {
  // A schema change takes the workspace's schema lock exclusively and then
  // bumps workspaces.schema_version (schema-engine, templates, upgrade).
  // Deleting and removing must take that lock before touching the row.
  async function schemaChange(workspace: string, started: () => void) {
    await db.owner.begin(async (tx) => {
      await lockSchemaExclusive(tx as unknown as Tx, workspace);
      started();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`update workspaces set schema_version=schema_version+1 where id=${workspace}`;
    });
  }

  it('deletes without a deadlock', async () => {
    const s = await setup();
    await install(s);
    let started!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const change = schemaChange(s.workspace, started);
    await locked;
    const [deleted] = await Promise.all([remove(s), change]);
    expect(deleted.status).toBe(200);
  });

  it('removes for good without a deadlock', async () => {
    const s = await setup();
    await install(s, standalone);
    expect((await remove(s)).status).toBe(200);
    await backdate(s.workspace, 8);
    let started!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const change = schemaChange(s.workspace, started);
    await locked;
    const [report] = await Promise.all([purgeDeletedWorkspaces(control()), change]);
    expect(report.failed).toBe(0);
    expect(await exists(s.workspace)).toBe(false);
  });
});
