import { randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { beforeAll, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { createOrganization, setOrganizationMember } from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import { connect, fetchClientMetadata, token } from '../helpers/oauth.js';

const db = useTestDatabase();
let app: AccountsTestApp;
beforeAll(() => {
  app = startAccountsApp(db, { fetchClientMetadata });
});

const redir = 'http://127.0.0.1:58374/callback';
async function fixture() {
  const person = await app.signIn();
  const [user] = await db.owner<
    { email: string }[]
  >`select email from users where id=${person.userId}`;
  if (!user) throw new Error('missing test account');
  const { email } = user;
  const organization = await createOrganization(db.owner, { name: 'CLI tests' });
  await setOrganizationMember(db.owner, { organization: organization.id, email, role: 'owner' });
  const workspace = await createWorkspace(db.owner, {
    name: 'Sales',
    slug: `sales-${randomUUID().slice(0, 8)}`,
    organization: organization.id,
    template: 'sales',
  });
  const signIn = () =>
    connect(app.accounts, {
      cookie: person.cookie,
      clientId: 'retainer-cli',
      redirectUri: redir,
      scope: 'read offline_access',
      resource: `${ORIGIN}/cli`,
      state: `${randomBytes(32).toString('base64url')}.VGVzdCBNYWM`,
    });
  const login = await signIn();
  const userHeaders = { cookie: person.cookie, origin: ORIGIN, 'x-retainer-client': 'web' };
  const cliHeaders = {
    authorization: `Bearer ${login.access_token}`,
    'x-retainer-workspace': workspace.id,
  };
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = cliHeaders,
  ) => {
    const service = path.startsWith('/account') ? app.accounts : app.api;
    return service.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  return { workspace, person, signIn, login, request, userHeaders, cliHeaders };
}

it('issues distinct CLI grants and fences their audiences and lifecycle', async () => {
  const t = await fixture();
  const second = await t.signIn();
  const firstClaims = decodeJwt(t.login.access_token);
  expect(firstClaims).toMatchObject({
    azp: 'retainer-cli',
    aud: `${ORIGIN}/cli`,
    scope: 'read offline_access',
  });
  expect(firstClaims.cli_login).not.toBe(decodeJwt(second.access_token).cli_login);
  expect((await t.request('/account')).status).toBe(200);
  expect((await t.request('/v1/schema')).status).toBe(200);
  expect((await t.request('/v1/records/me/forget', 'POST', {})).status).toBe(403);
  expect((await t.request('/account/auth/get-session')).status).toBe(403);
  expect((await t.request('/mcp', 'POST', {})).ok).toBe(false);
  const headers = { authorization: `Bearer ${t.login.access_token}` };
  expect((await t.request('/account/cli/login', 'DELETE', undefined, headers)).status).toBe(204);
  expect((await t.request('/account', 'GET', undefined, headers)).status).toBe(401);
  expect(
    (
      await t.request('/account', 'GET', undefined, {
        authorization: `Bearer ${second.access_token}`,
      })
    ).status,
  ).toBe(200);
  const refreshed = await token(app.accounts, {
    client_id: 'retainer-cli',
    grant_type: 'refresh_token',
    refresh_token: t.login.refresh_token ?? '',
    resource: `${ORIGIN}/cli`,
  });
  expect(refreshed.ok).toBe(false);
});

it('ends an elevation while schema approval is blocked on a lock', async () => {
  const t = await fixture();
  const key = await createApiKey(db.owner, {
    workspace: t.workspace.id,
    name: 'Schema agent',
    actor: { type: 'agent', id: 'test' },
    scopes: ['schema:write'],
  });
  const proposed = await t.request(
    '/v1/schema/changes',
    'POST',
    { operations: [{ op: 'rename_field', object: 'company', field: 'name', name: 'legalName' }] },
    { authorization: `Bearer ${key.key}` },
  );
  expect(proposed.status).toBe(202);
  const {
    change: { id: schemaChange },
  } = (await proposed.json()) as { change: { id: string } };
  const decision = () => t.request(`/v1/schema/changes/${schemaChange}/reject`, 'POST');
  expect(await (await decision()).json()).toMatchObject({ error: { code: 'elevation_required' } });
  const started = await t.request('/account/cli/approvals', 'POST', {
    workspaceId: t.workspace.id,
  });
  expect(started.status).toBe(201);
  const { id } = (await started.json()) as { id: string };
  const path = `/account/cli/approvals/${id}`;
  const clicks = await Promise.all(
    [true, true].map((allow) => t.request(`${path}/decide`, 'POST', { allow }, t.userHeaders)),
  );
  expect(clicks.map((click) => click.status).sort()).toEqual([200, 409]);
  const blocked = await db.owner.reserve();
  let pending: Promise<Response> | undefined;
  try {
    await blocked`begin`;
    await blocked`select id from schema_changes where id=${schemaChange} for update`;
    pending = Promise.resolve(decision());
    await expect
      .poll(async () => {
        const [row] = await db.owner<{ waiting: boolean }[]>`select exists (
        select 1 from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%from schema_changes where id =%for update%') as waiting`;
        return row?.waiting;
      })
      .toBe(true);
    expect((await t.request(`${path}/end`, 'POST')).status).toBe(204);
  } finally {
    await blocked`rollback`;
    blocked.release();
  }
  expect(await (await pending)?.json()).toMatchObject({ error: { code: 'elevation_required' } });
});

it('consumes each API key confirmation once and retains only the result ID', async () => {
  const t = await fixture();
  const path = `/account/workspaces/${t.workspace.id}/keys`;
  const input = { name: 'Test key', access: 'read' };
  const started = await t.request(path, 'POST', input);
  const body = (await started.json()) as { error: { code: string; details: { id: string } } };
  expect(body.error.code).toBe('confirmation_required');
  const approval = `/account/cli/approvals/${body.error.details.id}`;
  expect((await t.request(`${approval}/decide`, 'POST', { allow: true }, t.userHeaders)).ok).toBe(
    true,
  );
  const approved = { ...t.cliHeaders, 'x-retainer-approval': body.error.details.id };
  expect((await t.request(path, 'POST', { ...input, access: 'write' }, approved)).status).toBe(409);
  const results = await Promise.all([
    t.request(path, 'POST', input, approved),
    t.request(path, 'POST', input, approved),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  const created = (await results.find((result) => result.ok)?.json()) as { id: string };
  expect(await (await t.request(approval)).json()).toMatchObject({
    status: 'used',
    resultId: created.id,
  });
});

it('refuses another login and another person, and checks the expiry after waiting on the approval row', async () => {
  const t = await fixture();
  const started = await t.request('/account/cli/approvals', 'POST', {
    workspaceId: t.workspace.id,
  });
  const { id } = (await started.json()) as { id: string };
  const path = `/account/cli/approvals/${id}`;
  const second = await t.signIn();
  const otherHeaders = { authorization: `Bearer ${second.access_token}` };
  expect((await t.request(path, 'GET', undefined, otherHeaders)).status).toBe(404);
  expect((await t.request(`${path}/end`, 'POST', undefined, otherHeaders)).status).toBe(404);
  expect((await t.request(`${path}/decide`, 'POST', { allow: true })).status).toBe(403);
  const other = await app.signIn();
  const forbidden = await t.request(
    `${path}/decide`,
    'POST',
    { allow: true },
    { ...t.userHeaders, cookie: other.cookie },
  );
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({
    error: { message: 'This request is for another account.' },
  });

  await db.owner`update cli_approvals set expires_at=clock_timestamp()+interval '2 seconds' where id=${id}`;
  const lock = await db.owner.reserve();
  let click: Promise<Response> | undefined;
  try {
    await lock`begin`;
    await lock`select id from cli_approvals where id=${id} for update`;
    click = Promise.resolve(t.request(`${path}/decide`, 'POST', { allow: true }, t.userHeaders));
    await expect
      .poll(async () => {
        const [row] = await db.owner<{ waiting: boolean }[]>`select exists (
        select 1 from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like 'select id from cli_approvals where id=% for update') as waiting`;
        return row?.waiting;
      })
      .toBe(true);
    await lock`select pg_sleep(2)`;
  } finally {
    await lock`rollback`;
    lock.release();
  }
  expect((await click)?.status).toBe(409);
  expect(await (await t.request(path)).json()).toMatchObject({ status: 'expired' });
});

it('merges only the pending suggestion and records the CLI identity', async () => {
  const t = await fixture();
  const browser = { ...t.userHeaders, 'x-retainer-workspace': t.workspace.id };
  const records: string[] = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const response = await t.request(
      '/v1/objects/company/records',
      'POST',
      { values: { name } },
      browser,
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    records.push(id);
  }
  const [a, b] = records.slice(0, 2).sort();
  const [suggestion] = await db.owner<{ id: string }[]>`insert into merge_suggestions
    (workspace_id, record_a_id, record_b_id, reason, status) values
    (${t.workspace.id},${a ?? ''},${b ?? ''},'test','pending') returning id`;
  if (!suggestion) throw new Error('missing test suggestion');
  const path = `/v1/review/merges/${suggestion.id}/merge`;
  expect(await (await t.request(path, 'POST', { keep: b })).json()).toMatchObject({
    error: { code: 'elevation_required' },
  });
  const started = await t.request('/account/cli/approvals', 'POST', {
    workspaceId: t.workspace.id,
  });
  const { id } = (await started.json()) as { id: string };
  expect(
    (await t.request(`/account/cli/approvals/${id}/decide`, 'POST', { allow: true }, t.userHeaders))
      .status,
  ).toBe(200);
  expect((await t.request(`/v1/records/${b}/merge`, 'POST', { recordId: a })).status).toBe(403);
  expect(
    (await t.request(path, 'POST', { keep: b, values: { name: 'bad override' } })).status,
  ).toBe(400);
  expect((await t.request(path, 'POST', { keep: records[2] })).status).toBe(422);
  expect(await (await t.request(path, 'POST', { keep: b })).json()).toMatchObject({
    id: b,
    mergedId: a,
    merged: true,
  });
  expect((await t.request(path, 'POST', { keep: b })).status).toBe(409);
  expect(
    await db.owner`select decided_by from merge_suggestions where id=${suggestion.id}`,
  ).toEqual([
    {
      decided_by: expect.objectContaining({
        id: t.person.userId,
        type: 'user',
        via: 'Retainer CLI',
      }),
    },
  ]);
});

it('does not let dynamic registration link the CLI resource', async () => {
  await fixture();
  const response = await app.accounts.request(`${ORIGIN}/account/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Retainer CLI',
      redirect_uris: [redir],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'read offline_access',
      resources: [`${ORIGIN}/cli`],
    }),
  });
  expect(response.ok).toBe(false);
  expect(
    await db.owner`select client_id from oauth_client_resources where resource_id=${`${ORIGIN}/cli`}`,
  ).toEqual([{ client_id: 'retainer-cli' }]);
});
