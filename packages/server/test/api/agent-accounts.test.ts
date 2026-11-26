import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { useTestDatabase } from '../helpers/db.js';
import { connect, fetchClientMetadata } from '../helpers/oauth.js';

/**
 * The workspace agent with people signed in (agent spec §6.7, §7): a chat
 * works for its person, at agent rank within their role, and stops the
 * moment their access or the CLI login's elevation ends.
 */
const db = useTestDatabase();
let app: AccountsTestApp;
beforeAll(() => {
  app = startAccountsApp(db, {
    fetchClientMetadata,
    agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url },
  });
});

const redir = 'http://127.0.0.1:58374/callback';

async function fixture() {
  const suffix = randomUUID().slice(0, 8);
  const email = `agent-owner-${suffix}@example.test`;
  const person = await app.signIn({ email, name: 'Maya Cohen', sub: `owner-${suffix}` });
  const organization = await createOrganization(db.owner, { name: 'Agent tests' });
  await setOrganizationMember(db.owner, { organization: organization.id, email, role: 'owner' });
  const workspace = await createWorkspace(db.owner, {
    name: 'Sales',
    slug: `sales-${suffix}`,
    organization: organization.id,
    template: 'sales',
  });
  const web = (cookie: string) => ({
    cookie,
    origin: ORIGIN,
    'x-retainer-client': 'web',
    'x-retainer-workspace': workspace.id,
  });
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = web(person.cookie),
  ) => {
    const service = path.startsWith('/account') ? app.accounts : app.api;
    const response = await service.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  /** A chat, its stream token, and a claimed turn, as the given headers. */
  const turn = async (headers: Record<string, string>) => {
    const chat = await request('/v1/agent/chats', 'POST', undefined, headers);
    expect(chat.status, JSON.stringify(chat.body)).toBe(201);
    const id = chat.body.id as string;
    const token = await request(`/v1/agent/chats/${id}/token`, 'POST', undefined, headers);
    expect(token.status).toBe(200);
    const claimed = await request(
      `/v1/agent/runtime/sessions/${id}/claim`,
      'POST',
      { streamToken: token.body.token },
      { authorization: `Bearer ${RUNTIME_SECRET}` },
    );
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    const tool = (name: string, input: unknown) =>
      request(
        `/v1/agent/runtime/sessions/${id}/tools/${name}`,
        'POST',
        { toolCallId: randomUUID(), input },
        { authorization: `Bearer ${claimed.body.turnToken}` },
      );
    return { id, turnToken: claimed.body.turnToken as string, claimed: claimed.body, tool };
  };
  return { person, email, organization, workspace, web, request, turn };
}

const person = (first: string) => ({
  object: 'person',
  values: { name: { first, last: 'Agent' }, emails: `${first.toLowerCase()}@acme.test` },
});

it('works for the signed-in person at agent rank, and stops when they lose access', async () => {
  const t = await fixture();
  const chat = await t.turn(t.web(t.person.cookie));
  const [session] = await db.owner<{ owner: string; person_id: string }[]>`
    select owner, person_id from agent_sessions where id = ${chat.id}`;
  expect(session).toEqual({ owner: `user:${t.person.userId}`, person_id: t.person.userId });
  expect(chat.claimed.addedParts[0]).toContain('You work for Maya Cohen');

  const written = await chat.tool('upsert_record', person('Noa'));
  expect(written.body.ok, JSON.stringify(written.body)).toBe(true);
  const [assertion] = await db.owner<{ actor: { type: string; id: string; name: string } }[]>`
    select actor from field_assertions where record_id = ${written.body.output.id} limit 1`;
  expect(assertion?.actor).toMatchObject({
    type: 'agent',
    id: `retainer-agent:${t.person.userId}`,
    name: 'Retainer agent for Maya Cohen',
  });

  // A colleague who is an editor, then loses the workspace.
  const colleagueEmail = `agent-colleague-${randomUUID().slice(0, 8)}@example.test`;
  const colleague = await app.signIn({ email: colleagueEmail, name: 'Colleague' });
  await setOrganizationMember(db.owner, {
    organization: t.organization.id,
    email: colleagueEmail,
    role: 'member',
  });
  await setWorkspaceMember(db.owner, {
    workspace: t.workspace.id,
    email: colleagueEmail,
    role: 'editor',
  });
  const theirs = await t.turn(t.web(colleague.cookie));
  // The owner can't see the colleague's chat.
  expect((await t.request(`/v1/agent/chats/${theirs.id}`)).status).toBe(404);
  expect((await theirs.tool('upsert_record', person('Tal'))).body.ok).toBe(true);
  await setWorkspaceMember(db.owner, {
    workspace: t.workspace.id,
    email: colleagueEmail,
    role: 'viewer',
  });
  // A viewer's agent reads but no longer writes.
  expect((await theirs.tool('describe_schema', {})).body.ok).toBe(true);
  expect((await theirs.tool('upsert_record', person('Viewer'))).body.ok).toBe(false);
  await db.owner`delete from workspace_members where user_id = ${colleague.userId}`;
  await db.owner`delete from organization_members where user_id = ${colleague.userId}`;
  expect((await theirs.tool('describe_schema', {})).body).toMatchObject({
    ok: false,
    error: { code: 'role' },
  });

  // Deleting the workspace stops the owner's turn at once.
  await db.owner`update workspaces set deletion_scheduled_at = now() where id = ${t.workspace.id}`;
  expect((await chat.tool('describe_schema', {})).body).toMatchObject({
    ok: false,
    error: { code: 'role' },
  });
});

it('refuses chats to keys and connected apps once people sign in', async () => {
  const t = await fixture();
  const key = await createApiKey(db.owner, {
    workspace: t.workspace.id,
    name: 'Bot',
    actor: { type: 'agent', id: 'bot' },
    scopes: ['read', 'write'],
  });
  const created = await t.request('/v1/agent/chats', 'POST', undefined, {
    authorization: `Bearer ${key.key}`,
  });
  expect(created.status).toBe(403);
});

it('writes from a CLI chat only while the login is elevated, as the agent', async () => {
  const t = await fixture();
  const login = await connect(app.accounts, {
    cookie: t.person.cookie,
    clientId: 'retainer-cli',
    redirectUri: redir,
    scope: 'read offline_access',
    resource: `${ORIGIN}/cli`,
    state: `${randomBytes(32).toString('base64url')}.VGVzdCBNYWM`,
  });
  const cli = {
    authorization: `Bearer ${login.access_token}`,
    'x-retainer-workspace': t.workspace.id,
  };
  const chat = await t.turn(cli);
  expect((await chat.tool('describe_schema', {})).body.ok).toBe(true);
  expect((await chat.tool('upsert_record', person('Before'))).body).toMatchObject({
    ok: false,
    error: { code: 'elevation_required' },
  });

  const started = await t.request(
    '/account/cli/approvals',
    'POST',
    { workspaceId: t.workspace.id },
    cli,
  );
  expect(started.status).toBe(201);
  const approval = `/account/cli/approvals/${started.body.id}`;
  expect(
    (
      await t.request(
        `${approval}/decide`,
        'POST',
        { allow: true },
        {
          cookie: t.person.cookie,
          origin: ORIGIN,
          'x-retainer-client': 'web',
        },
      )
    ).status,
  ).toBe(200);
  const written = await chat.tool('upsert_record', person('During'));
  expect(written.body.ok, JSON.stringify(written.body)).toBe(true);
  const [assertion] = await db.owner<{ actor: { type: string; id: string } }[]>`
    select actor from field_assertions where record_id = ${written.body.output.id} limit 1`;
  expect(assertion?.actor).toMatchObject({
    type: 'agent',
    id: `retainer-agent:${t.person.userId}`,
  });

  // The window ends mid-turn: the next write is refused.
  expect((await t.request(`${approval}/end`, 'POST', undefined, cli)).status).toBe(204);
  expect((await chat.tool('upsert_record', person('After'))).body).toMatchObject({
    ok: false,
    error: { code: 'elevation_required' },
  });

  // The CLI reaches the chat routes and nothing new: decisions stay closed to it.
  expect((await t.request('/v1/agent/chats', 'GET', undefined, cli)).status).toBe(200);
  expect(
    (await t.request(`/v1/agent/chats/${chat.id}/cancel`, 'POST', undefined, cli)).body,
  ).toEqual({ cancelled: true });

  // Signing the login out stops the chat's next turn at the stream token.
  expect((await t.request('/account/cli/login', 'DELETE', undefined, cli)).status).toBe(204);
  expect((await t.request(`/v1/agent/chats/${chat.id}/token`, 'POST', undefined, cli)).status).toBe(
    401,
  );
});
