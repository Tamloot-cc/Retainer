import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/operator/commands.js';
import {
  createOrganization,
  setOrganizationLimits,
  setOrganizationMember,
} from '../../src/workspaces/organizations.js';
import { type AccountsTestApp, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

// Quotas (accounts spec 4.8, 4.10): workspaces and people per organization,
// none unless an operator sets them. Each is checked under the
// organization's lock, so two creations racing for the last place make one.

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db);
});

type Signed = { cookie: string; userId: string; email: string };

async function person(name: string): Promise<Signed> {
  const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@quota.test`;
  return { ...(await app.signIn({ email, name })), email };
}

async function organizationOwnedBy(owner: Signed) {
  const organization = await createOrganization(db.owner, { name: 'Quota Co' });
  await setOrganizationMember(db.owner, {
    organization: organization.id,
    email: owner.email,
    role: 'owner',
  });
  return organization.id;
}

const createWorkspace = (who: Signed, organizationId: string, name: string) =>
  app.account('/account/workspaces', {
    cookie: who.cookie,
    method: 'POST',
    body: { name, organizationId },
  });

async function invite(owner: Signed, organizationId: string, email: string) {
  const res = await app.account(`/account/organizations/${organizationId}/invitations`, {
    cookie: owner.cookie,
    method: 'POST',
    body: { email, role: 'member' },
  });
  return {
    res,
    token: res.ok ? ((await res.json()) as { link: string }).link.split('/').pop() : '',
  };
}

describe('workspace quota', () => {
  it('is unlimited by default', async () => {
    const owner = await person('Unlimited');
    const organizationId = await organizationOwnedBy(owner);
    for (const name of ['One', 'Two', 'Three']) {
      expect((await createWorkspace(owner, organizationId, name)).status).toBe(201);
    }
  });

  it('refuses a workspace past the limit, in plain words', async () => {
    const owner = await person('Capped');
    const organizationId = await organizationOwnedBy(owner);
    await setOrganizationLimits(db.owner, {
      organization: organizationId,
      limits: { workspaces: 1 },
    });
    expect((await createWorkspace(owner, organizationId, 'First')).status).toBe(201);
    const refused = await createWorkspace(owner, organizationId, 'Second');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'limit_reached', message: 'This organization can have at most 1 workspaces.' },
    });
  });

  it('makes one workspace when two creations race for the last place', async () => {
    const owner = await person('Racer');
    const organizationId = await organizationOwnedBy(owner);
    await setOrganizationLimits(db.owner, {
      organization: organizationId,
      limits: { workspaces: 1 },
    });
    const results = await Promise.all([
      createWorkspace(owner, organizationId, 'Left'),
      createWorkspace(owner, organizationId, 'Right'),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    const [{ count } = { count: 0 }] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from workspaces where organization_id = ${organizationId}`;
    expect(count).toBe(1);
  });
});

describe('member quota', () => {
  it('refuses an invitation once the organization is full', async () => {
    const owner = await person('Full');
    const organizationId = await organizationOwnedBy(owner);
    const kept = await person('Kept');
    await setOrganizationMember(db.owner, {
      organization: organizationId,
      email: kept.email,
      role: 'member',
    });
    await setOrganizationLimits(db.owner, { organization: organizationId, limits: { members: 2 } });
    const { res } = await invite(owner, organizationId, 'someone@quota.test');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'limit_reached' } });
    // Someone already in it takes no new place, so they can still be invited.
    expect((await invite(owner, organizationId, kept.email)).res.status).toBe(201);
  });

  it('lets one of two people accept when they race for the last place, leaving the other invitation open', async () => {
    const owner = await person('Host');
    const organizationId = await organizationOwnedBy(owner);
    const [ana, ben] = [await person('Ana'), await person('Ben')];
    const toAna = await invite(owner, organizationId, ana.email);
    const toBen = await invite(owner, organizationId, ben.email);
    await setOrganizationLimits(db.owner, { organization: organizationId, limits: { members: 2 } });
    const accepts = await Promise.all([
      app.account(`/account/invitations/${toAna.token}/accept`, {
        cookie: ana.cookie,
        method: 'POST',
      }),
      app.account(`/account/invitations/${toBen.token}/accept`, {
        cookie: ben.cookie,
        method: 'POST',
      }),
    ]);
    expect(accepts.map((r) => r.status).toSorted()).toEqual([200, 409]);
    const members = await db.owner`
      select 1 from organization_members where organization_id = ${organizationId}`;
    expect(members).toHaveLength(2);
    // The refused accept rolled back its claim, so it can be accepted once there is room.
    const open = await db.owner`
      select 1 from invitations where organization_id = ${organizationId} and accepted_at is null`;
    expect(open).toHaveLength(1);
  });
});

describe('retainer org limit', () => {
  async function cli(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      sql: db.owner,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('sets, keeps and clears limits', async () => {
    const { id } = await createOrganization(db.owner, { name: 'Billing seam' });
    const set = await cli('org', 'limit', '--org', id, '--workspaces', '3', '--members', '10');
    expect(set).toMatchObject({ code: 0 });
    expect(set.out).toContain('workspaces: 3');
    // A limit left out keeps its value; `none` clears one.
    const cleared = await cli('org', 'limit', '--org', id, '--members', 'none');
    expect(cleared.out).toContain('workspaces: 3');
    expect(cleared.out).toContain('members: no limit');
    const [row] = await db.owner<{ limits: unknown }[]>`
      select limits from organizations where id = ${id}`;
    expect(row?.limits).toEqual({ workspaces: 3 });
    expect(await cli('org', 'limit', '--org', id, '--members', 'lots')).toMatchObject({ code: 1 });
    // Postgres reads limits as an int, so a larger one is refused, not stored.
    expect(await cli('org', 'limit', '--org', id, '--members', '2147483648')).toMatchObject({
      code: 1,
    });
    expect(await cli('org', 'limit', '--org', id, '--members', '2147483647')).toMatchObject({
      code: 0,
    });
  });
});
