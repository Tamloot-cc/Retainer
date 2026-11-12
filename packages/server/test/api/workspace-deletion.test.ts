import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { CONTROL_ROLE, loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { createControlHandler } from '../../src/lambda/control.js';
import { runCli } from '../../src/operator/commands.js';
import { PURGE_TASK } from '../../src/worker/purge.js';
import { purgeDeletedWorkspaces, restoreWorkspace } from '../../src/workspaces/deletion.js';
import {
  createOrganization,
  setOrganizationLimits,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

// Deleting a workspace (accounts spec 4.5, "Deleting"): an organization
// owner or admin deletes it from Settings; every lookup treats it as gone at
// once, and a scheduled run removes it for good after 7 days, unless an
// operator restores it first.

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db);
});

type Signed = { cookie: string; userId: string; email: string };

async function person(name: string): Promise<Signed> {
  const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@delete.test`;
  return { ...(await app.signIn({ email, name })), email };
}

/** An organization with an owner, a workspace admin and an agent key. */
async function setup(name = 'Doomed') {
  const owner = await person('Owner');
  const admin = await person('Admin');
  const organizationId = (await createOrganization(db.owner, { name: 'Del Co' })).id;
  const workspace = await createWorkspace(db.owner, {
    name,
    slug: `del-${Math.random().toString(16).slice(2, 10)}`,
    template: 'sales',
    organization: organizationId,
  });
  await setOrganizationMember(db.owner, {
    organization: organizationId,
    email: owner.email,
    role: 'owner',
  });
  await setOrganizationMember(db.owner, {
    organization: organizationId,
    email: admin.email,
    role: 'member',
  });
  await setWorkspaceMember(db.owner, {
    workspace: workspace.id,
    email: admin.email,
    role: 'admin',
  });
  const { key } = await createApiKey(db.owner, {
    workspace: workspace.id,
    name: 'bot',
    actor: { type: 'agent', id: 'bot' },
    scopes: ['read', 'write'],
  });
  return { owner, admin, organizationId, workspace, key };
}

const remove = (who: Signed, workspaceId: string, name: string) =>
  app.account(`/account/workspaces/${workspaceId}`, {
    cookie: who.cookie,
    method: 'DELETE',
    body: { name },
  });

const withKey = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  app.api.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const backdate = (workspaceId: string, days: number) =>
  db.owner`update workspaces set deletion_scheduled_at = now() - make_interval(days => ${days})
    where id = ${workspaceId}`;

const exists = async (workspaceId: string) =>
  (await db.owner`select 1 from workspaces where id = ${workspaceId}`).length === 1;

describe('deleting a workspace', () => {
  it('is gone at once for keys, sessions, the account and the consolidator', async () => {
    const t = await setup();
    expect((await withKey(t.key, '/v1/me')).status).toBe(200);
    const res = await remove(t.owner, t.workspace.id, 'Doomed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletionScheduledAt: string; purgeAfter: string };
    const days =
      (Date.parse(body.purgeAfter) - Date.parse(body.deletionScheduledAt)) / (24 * 3600_000);
    expect(days).toBe(7);

    const key = await withKey(t.key, '/v1/me');
    expect(key.status).toBe(401);
    expect(
      (await app.v1('/v1/me', { cookie: t.owner.cookie, workspace: t.workspace.id })).status,
    ).toBe(404);
    const account = (await (await app.account('/account', { cookie: t.owner.cookie })).json()) as {
      organizations: { workspaces: { id: string }[] }[];
    };
    expect(account.organizations.flatMap((o) => o.workspaces.map((w) => w.id))).not.toContain(
      t.workspace.id,
    );
    const app_ = db.connect({ role: RUNTIME_ROLE, max: 1 });
    const due = await app_<{ id: string }[]>`
      select retainer_workspaces_due as id from retainer_workspaces_due(interval '0 seconds')`;
    expect(due.map((d) => d.id)).not.toContain(t.workspace.id);
    // Its rows stay for the grace period.
    expect(await exists(t.workspace.id)).toBe(true);
  });

  it('is for organization owners and admins, who type its name; others are refused', async () => {
    const t = await setup();
    const outsider = await person('Outsider');
    expect((await remove(outsider, t.workspace.id, 'Doomed')).status).toBe(404);
    const byAdmin = await remove(t.admin, t.workspace.id, 'Doomed');
    expect(byAdmin.status).toBe(403);
    const mistyped = await remove(t.owner, t.workspace.id, 'Doomd');
    expect(mistyped.status).toBe(400);
    expect((await withKey(t.key, '/v1/me')).status).toBe(200);
    expect((await remove(t.owner, t.workspace.id, ' Doomed ')).status).toBe(200);
    // Deleting it again finds nothing.
    expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(404);
  });

  it('deletes once when two people delete it at the same time', async () => {
    const t = await setup();
    const results = await Promise.all([
      remove(t.owner, t.workspace.id, 'Doomed'),
      remove(t.owner, t.workspace.id, 'Doomed'),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 404]);
  });

  it('refuses every write after the deletion commits, while writes racing it end cleanly', async () => {
    const t = await setup();
    const write = (i: number) =>
      withKey(t.key, '/v1/objects/company/records', {
        method: 'POST',
        body: { values: { name: `Racer ${i}` } },
      });
    const [writes, deleted] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, (_, i) => write(i))),
      remove(t.owner, t.workspace.id, 'Doomed'),
    ]);
    expect(deleted.status).toBe(200);
    // Each write either landed before the deletion or was refused: no errors.
    for (const res of writes) expect([201, 401]).toContain(res.status);
    expect((await write(99)).status).toBe(401);
  });

  it('no longer counts against the workspace quota, and invitations skip it', async () => {
    const t = await setup();
    await setOrganizationLimits(db.owner, {
      organization: t.organizationId,
      limits: { workspaces: 1 },
    });
    const create = () =>
      app.account('/account/workspaces', {
        cookie: t.owner.cookie,
        method: 'POST',
        body: { name: 'Next', organizationId: t.organizationId },
      });
    expect((await create()).status).toBe(409);
    expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
    expect((await create()).status).toBe(201);
    const invited = await app.account(`/account/organizations/${t.organizationId}/invitations`, {
      cookie: t.owner.cookie,
      method: 'POST',
      body: {
        email: 'new@delete.test',
        role: 'member',
        workspaces: [{ workspaceId: t.workspace.id, role: 'viewer' }],
      },
    });
    expect(invited.status).toBe(404);
  });

  it('keeps the organization until the workspace is removed for good', async () => {
    const t = await setup();
    expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
    const res = await app.account(`/account/organizations/${t.organizationId}`, {
      cookie: t.owner.cookie,
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
  });
});

describe('removing deleted workspaces for good', () => {
  const control = () => db.connect({ role: CONTROL_ROLE, max: 1 });

  it('removes those deleted over 7 days ago with all their data, and keeps the rest', async () => {
    const old = await setup();
    const recent = await setup();
    const live = await setup();
    expect(
      (
        await withKey(old.key, '/v1/objects/company/records', {
          method: 'POST',
          body: { values: { name: 'Gone Inc' } },
        })
      ).status,
    ).toBe(201);
    for (const t of [old, recent]) {
      expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
    }
    await backdate(old.workspace.id, 8);
    await backdate(recent.workspace.id, 6);

    const report = await purgeDeletedWorkspaces(control());
    expect(report).toEqual({ purged: 1, failed: 0, waiting: 0 });
    expect(await exists(old.workspace.id)).toBe(false);
    expect(
      await db.owner`select 1 from records where workspace_id = ${old.workspace.id}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select 1 from api_keys where workspace_id = ${old.workspace.id}`,
    ).toHaveLength(0);
    expect(await exists(recent.workspace.id)).toBe(true);
    expect(await exists(live.workspace.id)).toBe(true);
  });

  it('either removes or restores a workspace when both happen at once, never half of each', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await setup();
      expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
      await backdate(t.workspace.id, 8);
      const [purged, restored] = await Promise.allSettled([
        purgeDeletedWorkspaces(control()),
        restoreWorkspace(db.owner, t.workspace.id),
      ]);
      if (await exists(t.workspace.id)) {
        expect(restored.status).toBe('fulfilled');
        expect((await withKey(t.key, '/v1/me')).status).toBe(200);
      } else {
        expect(purged.status).toBe('fulfilled');
        expect(restored.status).toBe('rejected');
      }
    }
  });

  it('runs from the control function on a schedule', async () => {
    const t = await setup();
    expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
    await backdate(t.workspace.id, 8);
    let purgeSql: Sql | undefined;
    const handler = createControlHandler(
      loadConfig({
        DATABASE_URL: db.url,
        RETAINER_AUTH_SECRET: 'lambda-auth-secret-0123456789abcdef0123',
        RETAINER_GOOGLE_CLIENT_ID: 'lambda-client',
        RETAINER_GOOGLE_CLIENT_SECRET: 'lambda-secret',
        RETAINER_PUBLIC_ORIGIN: 'https://retainer.example',
        LOG_LEVEL: 'error',
      }),
      control(),
      control(),
      () => (purgeSql = db.connect({ role: CONTROL_ROLE, max: 1, keepConnections: true })),
    );
    expect(await handler({ task: PURGE_TASK })).toMatchObject({ failed: 0 });
    expect(await exists(t.workspace.id)).toBe(false);
    // The run's own connection is closed, so a warm instance keeps only its
    // /account pools within the connection budget.
    if (!purgeSql) throw new Error('the purge opened no connection');
    const closed = purgeSql;
    await expect(Promise.resolve(closed`select 1`)).rejects.toThrow();
  });
});

describe('retainer workspace restore', () => {
  it('undoes a deletion, so keys work again', async () => {
    const t = await setup();
    expect((await remove(t.owner, t.workspace.id, 'Doomed')).status).toBe(200);
    const out: string[] = [];
    const io = { sql: db.owner, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(await runCli(['workspace', 'list'], io)).toBe(0);
    expect(out.join('\n')).toContain('deleted, removed for good after');
    expect(await runCli(['workspace', 'restore', t.workspace.slug], io)).toBe(0);
    expect((await withKey(t.key, '/v1/me')).status).toBe(200);
    // Restoring a workspace that is not being deleted is refused.
    expect(await runCli(['workspace', 'restore', t.workspace.slug], io)).toBe(1);
  });
});
