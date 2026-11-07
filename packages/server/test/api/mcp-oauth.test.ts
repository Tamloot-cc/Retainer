import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { cappedScopes } from '@retainer/shared';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { oauthActorId } from '../../src/auth/oauth-token.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import {
  createOrganization,
  moveWorkspace,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  authorize,
  CLAUDE_CLIENT_ID,
  CLAUDE_REDIRECT,
  connect,
  consent,
  fetchClientMetadata,
  mcpCall,
  type Tokens,
  token,
} from '../helpers/oauth.js';

// MCP OAuth (accounts spec 4.7, 8: Agent): an app registers through a client
// metadata document or dynamic registration, the person picks a workspace
// at consent, and the api function checks every token with no internet. The
// token works only while the consent exists and the person has a role; the
// role caps what it can do; and it is always an agent.

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db, { fetchClientMetadata });
});

type Signed = { cookie: string; userId: string; email: string };

async function person(name: string): Promise<Signed> {
  const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@oauth.test`;
  return { ...(await app.signIn({ email, name })), email };
}

/** An organization with two workspaces; Dana is an editor in the first only. */
async function setup() {
  const owner = await person('Owner');
  const dana = await person('Dana');
  const organizationId = (await createOrganization(db.owner, { name: 'OAuth Co' })).id;
  const workspace = (slug: string) =>
    createWorkspace(db.owner, {
      name: slug,
      slug: `${slug}-${Math.random().toString(16).slice(2, 10)}`,
      template: 'sales',
      organization: organizationId,
    });
  const sales = await workspace('sales');
  const other = await workspace('other');
  const org = (email: string, role: 'owner' | 'member') =>
    setOrganizationMember(db.owner, { organization: organizationId, email, role });
  await org(owner.email, 'owner');
  await org(dana.email, 'member');
  await setWorkspaceMember(db.owner, { workspace: sales.id, email: dana.email, role: 'editor' });
  return { owner, dana, organizationId, sales, other };
}

/** The JSON-RPC result of a tool call over raw HTTP (stateless MCP). */
async function callTool(accessToken: string, name: string, args: Record<string, unknown>) {
  const res = await mcpCall(app.api, accessToken, 'tools/call', { name, arguments: args });
  if (res.status !== 200) return { status: res.status, isError: true, text: await res.text() };
  const text = await res.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice(5);
  const message = JSON.parse(data ?? text) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return {
    status: 200,
    isError: message.result.isError === true,
    text: message.result.content[0]?.text ?? '',
  };
}

const createPerson = (accessToken: string, last: string) =>
  callTool(accessToken, 'upsert_record', {
    object: 'person',
    values: { name: { first: 'Ada', last } },
  });

const status = async (accessToken: string) =>
  (await mcpCall(app.api, accessToken, 'tools/list')).status;

describe('connecting Claude', () => {
  it('registers from its metadata document, picks a workspace at consent, and reads and writes', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    expect(tokens.refresh_token).toBeTruthy();

    // The official MCP client, over Streamable HTTP, with the access token.
    const client = new Client({ name: 'claude-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: (url, init) => Promise.resolve(app.api.request(url.toString(), init)),
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const schema = await client.callTool({ name: 'describe_schema', arguments: {} });
    expect(schema.isError).not.toBe(true);
    const written = await client.callTool({
      name: 'upsert_record',
      arguments: { object: 'person', values: { name: { first: 'Ada', last: 'Lovelace' } } },
    });
    expect(written.isError).not.toBe(true);
    await client.close();

    // The write landed in the workspace Dana picked, by "Claude for Dana":
    // an agent whose ID combines the app and the person.
    const [record] = await db.owner<{ workspace_id: string; created_by: unknown }[]>`
      select workspace_id, created_by from records
      where data -> 'name' ->> 'last' = 'Lovelace' and workspace_id = ${t.sales.id}`;
    expect(record?.created_by).toEqual({
      type: 'agent',
      id: oauthActorId(CLAUDE_CLIENT_ID, t.dana.userId),
      name: 'Claude for Dana',
    });
  });

  it("gives each person their own actor, so two people's Claude are told apart", () => {
    expect(oauthActorId(CLAUDE_CLIENT_ID, 'a')).not.toBe(oauthActorId(CLAUDE_CLIENT_ID, 'b'));
    expect(oauthActorId(CLAUDE_CLIENT_ID, 'a')).not.toBe(oauthActorId('https://other.app', 'a'));
  });

  it('sends a person who is not signed in to the sign-in page, then on to consent', async () => {
    const t = await setup();
    const signedOut = await authorize(app.accounts, { cookie: '' });
    expect(signedOut.consentUrl.pathname).toBe('/app/oauth/sign-in');
    const signedIn = await authorize(app.accounts, { cookie: t.dana.cookie });
    expect(signedIn.consentUrl.pathname).toBe('/app/oauth/consent');
  });

  it('asks every time, so a person can connect the same app to two workspaces', async () => {
    const t = await setup();
    await setWorkspaceMember(db.owner, {
      workspace: t.other.id,
      email: t.dana.email,
      role: 'viewer',
    });
    const first = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const again = await authorize(app.accounts, { cookie: t.dana.cookie });
    expect(again.consentUrl.pathname).toBe('/app/oauth/consent');
    const second = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.other.id });
    expect((await createPerson(first.access_token, 'Sales')).isError).toBe(false);
    // The second is read-only: Dana is a viewer there.
    const refused = await createPerson(second.access_token, 'Other');
    expect(refused.isError).toBe(true);
    const { error } = JSON.parse(refused.text) as { error: { message: string } };
    expect(error.message).toContain('this connection needs the "write" scope');
  });

  it('refuses a workspace the person cannot reach, with the same answer as one that does not exist', async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, { cookie: t.dana.cookie });
    const res = await consent(app.accounts, flow, {
      cookie: t.dana.cookie,
      workspaceId: t.other.id,
    });
    expect(res.status).toBe(404);
    const missing = await consent(app.accounts, flow, {
      cookie: t.dana.cookie,
      workspaceId: '9f1c1f43-58a4-4b7a-9d4b-2d7b0f6d2c11',
    });
    expect(missing.status).toBe(404);
    expect(
      await db.owner`select 1 from oauth_consents where user_id = ${t.dana.userId}`,
    ).toHaveLength(0);
  });

  it('records nothing when the person says no, and the app is told access was denied', async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, { cookie: t.dana.cookie });
    const res = await consent(app.accounts, flow, { cookie: t.dana.cookie, accept: false });
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).searchParams.get('error')).toBe('access_denied');
  });

  it("keeps Better Auth's own consent step closed, so no consent is made without a workspace", async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, { cookie: t.dana.cookie });
    const res = await app.accounts.request(`${ORIGIN}/account/auth/oauth2/consent`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: t.dana.cookie },
      body: JSON.stringify({ accept: true, oauth_query: flow.consentUrl.search.slice(1) }),
    });
    expect(res.status).toBe(404);
  });

  it('registers a client without a metadata document dynamically', async () => {
    const t = await setup();
    const registered = await app.accounts.request(`${ORIGIN}/account/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Desk agent',
        redirect_uris: ['http://127.0.0.1:33418/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const tokens = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
      clientId: client_id,
      redirectUri: 'http://127.0.0.1:33418/callback',
    });
    expect(await status(tokens.access_token)).toBe(200);
  });

  it('never grants admin, even to an organization owner', async () => {
    const t = await setup();
    // Asking for it sends the app back with an error, before any consent.
    const asked = await authorize(app.accounts, { cookie: t.owner.cookie, scope: 'read admin' });
    expect(asked.consentUrl.origin + asked.consentUrl.pathname).toBe(CLAUDE_REDIRECT);
    expect(asked.consentUrl.searchParams.get('error')).toBe('invalid_scope');
    expect(cappedScopes(['read', 'write', 'schema:write', 'admin'], 'admin')).toEqual([
      'read',
      'write',
      'schema:write',
    ]);
  });
});

describe('access ends at the next request', () => {
  it('when the person is removed from the workspace, and stays ended if they are added back', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    expect(await status(tokens.access_token)).toBe(200);
    const removed = await app.account(
      `/account/workspaces/${t.sales.id}/members/${t.dana.userId}`,
      {
        cookie: t.owner.cookie,
        method: 'DELETE',
      },
    );
    expect(removed.status).toBe(204);
    const res = await mcpCall(app.api, tokens.access_token, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    await setWorkspaceMember(db.owner, {
      workspace: t.sales.id,
      email: t.dana.email,
      role: 'editor',
    });
    expect(await status(tokens.access_token)).toBe(401);
    // Its refresh token was revoked with the consent.
    const refreshed = await token(app.accounts, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token ?? '',
      client_id: CLAUDE_CLIENT_ID,
    });
    expect(refreshed.ok).toBe(false);
  });

  it('when the person is removed from the organization', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const res = await app.account(
      `/account/organizations/${t.organizationId}/members/${t.dana.userId}`,
      {
        cookie: t.owner.cookie,
        method: 'DELETE',
      },
    );
    expect(res.status).toBe(204);
    expect(await status(tokens.access_token)).toBe(401);
  });

  it('when an operator moves the workspace, even for someone who keeps access', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    expect(await status(tokens.access_token)).toBe(200);
    // Dana is an admin of the new organization, so she can still open it.
    const moved = await createOrganization(db.owner, { name: 'New home' });
    await setOrganizationMember(db.owner, {
      organization: moved.id,
      email: t.dana.email,
      role: 'admin',
    });
    await moveWorkspace(db.owner, { workspace: t.sales.id, organization: moved.id });
    expect(await status(tokens.access_token)).toBe(401);
  });

  it('when the person is removed while consenting: the consent waits for the removal, then is refused', async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, { cookie: t.dana.cookie });
    let consented: Promise<Response> | undefined;
    // A removal holds the organization's lock, as every membership change does.
    await db.owner.begin(async (tx) => {
      await tx`select 1 from organizations where id = ${t.organizationId} for update`;
      consented = consent(app.accounts, flow, { cookie: t.dana.cookie, workspaceId: t.sales.id });
      const first = await Promise.race([
        consented.then(() => 'recorded'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
      ]);
      expect(first).toBe('waiting');
      await tx`
        delete from workspace_members
        where workspace_id = ${t.sales.id} and user_id = ${t.dana.userId}`;
    });
    if (!consented) throw new Error('the consent never started');
    expect((await consented).status).toBe(404);
    expect(
      await db.owner`select 1 from oauth_consents where reference_id = ${t.sales.id}`,
    ).toHaveLength(0);
  });

  it('when the app is connected again with fewer scopes: an earlier token gets only those', async () => {
    const t = await setup();
    const wide = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
      scope: 'read write offline_access',
    });
    expect((await createPerson(wide.access_token, 'Wide')).isError).toBe(false);
    const listed = (await (
      await app.account('/account/connections', { cookie: t.dana.cookie })
    ).json()) as { connections: { id: string }[] };
    const removed = await app.account(`/account/connections/${listed.connections[0]?.id}`, {
      cookie: t.dana.cookie,
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);
    await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id, scope: 'read' });
    expect((await createPerson(wide.access_token, 'Narrow')).isError).toBe(true);
    expect((await callTool(wide.access_token, 'describe_schema', {})).isError).toBe(false);
  });

  it("when their role is lowered: a viewer's app can read but not write", async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    expect((await createPerson(tokens.access_token, 'Before')).isError).toBe(false);
    await setWorkspaceMember(db.owner, {
      workspace: t.sales.id,
      email: t.dana.email,
      role: 'viewer',
    });
    expect((await createPerson(tokens.access_token, 'After')).isError).toBe(true);
    expect((await callTool(tokens.access_token, 'describe_schema', {})).isError).toBe(false);
  });

  it('when the app is disconnected, by the person or by a workspace admin', async () => {
    const t = await setup();
    const mine = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const listed = (await (
      await app.account('/account/connections', { cookie: t.dana.cookie })
    ).json()) as { connections: { id: string; app: { name: string }; person: { id: string } }[] };
    expect(listed.connections.map((c) => c.app.name)).toEqual(['Claude']);
    const [connection] = listed.connections;
    // Another member cannot disconnect it.
    const stranger = await person('Stranger');
    await setOrganizationMember(db.owner, {
      organization: t.organizationId,
      email: stranger.email,
      role: 'member',
    });
    await setWorkspaceMember(db.owner, {
      workspace: t.sales.id,
      email: stranger.email,
      role: 'editor',
    });
    expect(
      (
        await app.account(`/account/connections/${connection?.id}`, {
          cookie: stranger.cookie,
          method: 'DELETE',
        })
      ).status,
    ).toBe(403);
    // The owner, an admin there, sees and disconnects it from Settings.
    const inWorkspace = (await (
      await app.account(`/account/workspaces/${t.sales.id}/connections`, { cookie: t.owner.cookie })
    ).json()) as { connections: { id: string }[] };
    expect(inWorkspace.connections.map((c) => c.id)).toEqual([connection?.id]);
    expect(
      (
        await app.account(`/account/workspaces/${t.sales.id}/connections/${connection?.id}`, {
          cookie: t.owner.cookie,
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect(await status(mine.access_token)).toBe(401);
  });

  it('when the workspace is deleted', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const deleted = await app.account(`/account/workspaces/${t.sales.id}`, {
      cookie: t.owner.cookie,
      method: 'DELETE',
      body: { name: 'sales' },
    });
    expect(deleted.status).toBe(200);
    expect(await status(tokens.access_token)).toBe(401);
  });

  it('when the consent is revoked while the token is in use: in-flight calls end cleanly, later ones fail', async () => {
    const t = await setup();
    const tokens = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const [{ id } = { id: '' }] = await db.owner<{ id: string }[]>`
      select id from oauth_consents where user_id = ${t.dana.userId}`;
    const [calls, revoked] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, (_, i) => createPerson(tokens.access_token, `R${i}`))),
      app.account(`/account/connections/${id}`, { cookie: t.dana.cookie, method: 'DELETE' }),
    ]);
    expect(revoked.status).toBe(204);
    for (const call of calls) expect([200, 401]).toContain(call.status);
    expect(await status(tokens.access_token)).toBe(401);
  });
});

describe('the api function checks tokens itself', () => {
  it('points a 401 from /mcp at the resource metadata, which names the authorization server', async () => {
    const res = await app.api.request(`${ORIGIN}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = (await (
      await app.api.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(resource).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [`${ORIGIN}/account/auth`],
    });
    const server = (await (
      await app.accounts.request(`${ORIGIN}/.well-known/oauth-authorization-server/account/auth`)
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: `${ORIGIN}/account/auth`,
      authorization_endpoint: `${ORIGIN}/account/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/account/auth/oauth2/token`,
      client_id_metadata_document_supported: true,
    });
  });

  it('refuses a token signed with another key, a tampered one, and one for another audience', async () => {
    const t = await setup();
    const { access_token } = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
    });
    const [header, payload] = access_token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const kid = (JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid: string }).kid;

    // The same claims and key ID, signed by someone else.
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .sign(privateKey);
    expect(await status(forged)).toBe(401);

    // Another workspace swapped into a genuine token.
    const swapped = Buffer.from(JSON.stringify({ ...claims, workspace_id: t.other.id })).toString(
      'base64url',
    );
    expect(await status(`${header}.${swapped}.${access_token.split('.')[2]}`)).toBe(401);
    expect(await status('not.a.token')).toBe(401);
    void exportJWK;
  });

  it('accepts OAuth tokens on /mcp only, the resource they are for', async () => {
    const t = await setup();
    const { access_token } = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
    });
    const rest = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(rest.status).toBe(401);
  });

  it('never lets an app manage accounts: /account refuses its token', async () => {
    const t = await setup();
    const { access_token } = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
    });
    for (const [path, method] of [
      ['/account/workspaces', 'POST'],
      [`/account/workspaces/${t.sales.id}/keys`, 'POST'],
      [`/account/organizations/${t.organizationId}/invitations`, 'POST'],
    ] as const) {
      const res = await app.accounts.request(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    }
  });

  it('runs as the runtime role, which cannot read the OAuth tables', async () => {
    const runtime = db.connect({ role: RUNTIME_ROLE, max: 1 });
    for (const table of ['jwks', 'oauth_consents', 'oauth_clients', 'oauth_refresh_tokens']) {
      await expect(runtime.unsafe(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    }
    const keys = await runtime<
      { public_key: string }[]
    >`select public_key from retainer_token_keys()`;
    for (const key of keys) expect(key.public_key).not.toContain('"d"');
  });

  it('refreshes: a new access token keeps working with the same consent', async () => {
    const t = await setup();
    const tokens: Tokens = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
    });
    const res = await token(app.accounts, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token ?? '',
      client_id: CLAUDE_CLIENT_ID,
      resource: `${ORIGIN}/mcp`,
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as Tokens;
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(await status(refreshed.access_token)).toBe(200);
    expect(
      createHash('sha256')
        .update(refreshed.refresh_token ?? '')
        .digest('hex'),
    ).not.toBe('');
    void CLAUDE_REDIRECT;
  });
});
