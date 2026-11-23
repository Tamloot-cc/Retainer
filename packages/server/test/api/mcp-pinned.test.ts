import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { oauthActorId } from '../../src/auth/oauth-token.js';
import { CONTROL_ROLE } from '../../src/config.js';
import { purgeDeletedWorkspaces } from '../../src/workspaces/deletion.js';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  authorize,
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_REDIRECT,
  connect,
  consent,
  fetchClientMetadata,
  mcpCall,
} from '../helpers/oauth.js';

// An MCP address pinned to one workspace (accounts spec 4.7): `/mcp/w/<ID>`
// is the same server as `/mcp`, but its own OAuth resource. Its consent
// offers only that workspace, its tokens work only there, and the base
// address keeps letting the person pick. list_workspaces gives each
// workspace's address.

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db, { fetchClientMetadata });
});

const pinned = (workspaceId: string) => `/mcp/w/${workspaceId}`;
const address = (workspaceId: string) => `${ORIGIN}${pinned(workspaceId)}`;

type Signed = { cookie: string; userId: string; email: string };

async function person(name: string): Promise<Signed> {
  const email = `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@pinned.test`;
  return { ...(await app.signIn({ email, name })), email };
}

/** An organization with two workspaces; Dana is an editor in Sales only. */
async function setup() {
  const owner = await person('Owner');
  const dana = await person('Dana');
  const organizationId = (await createOrganization(db.owner, { name: 'Pinned Co' })).id;
  const workspace = (name: string) =>
    createWorkspace(db.owner, {
      name,
      slug: `${name.toLowerCase()}-${Math.random().toString(16).slice(2, 10)}`,
      template: 'sales',
      organization: organizationId,
    });
  const sales = await workspace('Sales');
  const support = await workspace('Support');
  const org = (email: string, role: 'owner' | 'member') =>
    setOrganizationMember(db.owner, { organization: organizationId, email, role });
  await org(owner.email, 'owner');
  await org(dana.email, 'member');
  await setWorkspaceMember(db.owner, { workspace: sales.id, email: dana.email, role: 'editor' });
  return { owner, dana, organizationId, sales, support };
}

/** The JSON-RPC result of a tool call over raw HTTP (stateless MCP). */
async function callTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  path = '/mcp',
) {
  const res = await mcpCall(app.api, accessToken, 'tools/call', { name, arguments: args }, path);
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

const status = async (accessToken: string, path = '/mcp') =>
  (await mcpCall(app.api, accessToken, 'tools/list', {}, path)).status;

type Listed = {
  workspaces: { id: string; name: string; role?: string; current: boolean; address?: string }[];
};

describe('connecting through a pinned address', () => {
  it('links an app met for the first time, offers only that workspace, and works there', async () => {
    const t = await setup();
    // Claude Code has never connected: it registers from its metadata
    // document during this very authorization.
    expect(
      await db.owner`select 1 from oauth_clients where client_id = ${CLAUDE_CODE_CLIENT_ID}`,
    ).toHaveLength(0);
    const tokens = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
      clientId: CLAUDE_CODE_CLIENT_ID,
      redirectUri: 'http://localhost/callback',
      resource: address(t.sales.id),
    });
    expect(await status(tokens.access_token, pinned(t.sales.id))).toBe(200);
    const written = await callTool(
      tokens.access_token,
      'upsert_record',
      { object: 'person', values: { name: { first: 'Ada', last: 'Pinned' } } },
      pinned(t.sales.id),
    );
    expect(written.isError).toBe(false);
    const [record] = await db.owner<{ workspace_id: string; created_by: { id: string } }[]>`
      select workspace_id, created_by from records where data -> 'name' ->> 'last' = 'Pinned'`;
    expect(record?.workspace_id).toBe(t.sales.id);
    expect(record?.created_by.id).toBe(oauthActorId(CLAUDE_CODE_CLIENT_ID, t.dana.userId));
  });

  it('refuses consent for any other workspace, even one the person can reach', async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, {
      cookie: t.owner.cookie,
      resource: address(t.sales.id),
    });
    expect(flow.consentUrl.pathname).toBe('/app/oauth/consent');
    const res = await consent(app.accounts, flow, {
      cookie: t.owner.cookie,
      workspaceId: t.support.id,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wrong_workspace');
    expect(
      await db.owner`select 1 from oauth_consents where user_id = ${t.owner.userId}`,
    ).toHaveLength(0);
  });

  it('refuses consent for a workspace the person cannot reach', async () => {
    const t = await setup();
    const flow = await authorize(app.accounts, {
      cookie: t.dana.cookie,
      resource: address(t.support.id),
    });
    const res = await consent(app.accounts, flow, {
      cookie: t.dana.cookie,
      workspaceId: t.support.id,
    });
    expect(res.status).toBe(404);
  });

  it('sends the app back with invalid_target for a workspace that does not exist', async () => {
    const t = await setup();
    const missing = '9f1c1f43-58a4-4b7a-9d4b-2d7b0f6d2c11';
    const flow = await authorize(app.accounts, {
      cookie: t.dana.cookie,
      resource: address(missing),
    });
    expect(flow.consentUrl.origin + flow.consentUrl.pathname).toBe(CLAUDE_REDIRECT);
    expect(flow.consentUrl.searchParams.get('error')).toBe('invalid_target');
    expect(
      await db.owner`select 1 from oauth_resources where identifier = ${address(missing)}`,
    ).toHaveLength(0);
  });

  it('keeps tokens to their own address: base and pinned never stand in for each other', async () => {
    const t = await setup();
    const base = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const pin = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
      resource: address(t.sales.id),
    });
    expect(await status(base.access_token)).toBe(200);
    expect(await status(pin.access_token, pinned(t.sales.id))).toBe(200);
    expect(await status(base.access_token, pinned(t.sales.id))).toBe(401);
    expect(await status(pin.access_token)).toBe(401);
    // Nor does a pinned token reach another pinned address.
    expect(await status(pin.access_token, pinned(t.support.id))).toBe(401);
  });

  it('points a request without a token at the pinned address metadata, which names it', async () => {
    const t = await setup();
    const res = await app.api.request(`${ORIGIN}${pinned(t.sales.id)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const metadataUrl = `${ORIGIN}/.well-known/oauth-protected-resource${pinned(t.sales.id)}`;
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${metadataUrl}"`);
    const metadata = (await (await app.api.request(metadataUrl)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(metadata.resource).toBe(address(t.sales.id));
    expect(metadata.authorization_servers).toEqual([`${ORIGIN}/account/auth`]);
    // Only a workspace ID makes an address.
    expect((await app.api.request(`${ORIGIN}/mcp/w/not-a-workspace`)).status).toBe(404);
    expect(
      (await app.api.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/w/nope`)).status,
    ).toBe(404);
  });

  it("takes an API key only on its own workspace's address", async () => {
    const t = await setup();
    const { key } = await createApiKey(db.owner, {
      workspace: t.sales.id,
      name: 'pinned-agent',
      actor: { type: 'agent', id: 'pinned-agent', name: 'Pinned agent' },
      scopes: ['read'],
    });
    expect(await status(key, pinned(t.sales.id))).toBe(200);
    const res = await mcpCall(app.api, key, 'tools/list', {}, pinned(t.support.id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wrong_workspace');
  });

  it('makes the resource and its link once when the same app authorizes concurrently', async () => {
    const t = await setup();
    const flows = await Promise.all(
      Array.from({ length: 6 }, () =>
        authorize(app.accounts, { cookie: t.dana.cookie, resource: address(t.sales.id) }),
      ),
    );
    for (const flow of flows) expect(flow.consentUrl.pathname).toBe('/app/oauth/consent');
    expect(
      await db.owner`select 1 from oauth_resources where identifier = ${address(t.sales.id)}`,
    ).toHaveLength(1);
    expect(
      await db.owner`
        select 1 from oauth_client_resources
        where client_id = ${CLAUDE_CLIENT_ID} and resource_id = ${address(t.sales.id)}`,
    ).toHaveLength(1);
  });

  it('removes the pinned resource when its workspace is purged', async () => {
    const t = await setup();
    await authorize(app.accounts, { cookie: t.dana.cookie, resource: address(t.sales.id) });
    await db.owner`
      update workspaces set deletion_scheduled_at = now() - interval '30 days'
      where id = ${t.sales.id}`;
    const control = db.connect({ role: CONTROL_ROLE, max: 1 });
    try {
      expect((await purgeDeletedWorkspaces(control)).purged).toBeGreaterThanOrEqual(1);
    } finally {
      await control.end();
    }
    expect(
      await db.owner`select 1 from oauth_resources where identifier = ${address(t.sales.id)}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select 1 from oauth_client_resources where resource_id = ${address(t.sales.id)}`,
    ).toHaveLength(0);
  });
});

describe('list_workspaces', () => {
  it("lists every workspace the connection's person can reach, with each address", async () => {
    const t = await setup();
    const owner = await connect(app.accounts, { cookie: t.owner.cookie, workspaceId: t.sales.id });
    const listed = await callTool(owner.access_token, 'list_workspaces', {});
    expect(listed.isError).toBe(false);
    const { workspaces } = JSON.parse(listed.text) as Listed;
    expect(workspaces).toEqual([
      { id: t.sales.id, name: 'Sales', role: 'admin', current: true, address: address(t.sales.id) },
      {
        id: t.support.id,
        name: 'Support',
        role: 'admin',
        current: false,
        address: address(t.support.id),
      },
    ]);
  });

  it('shows a member only the workspaces they belong to, from a pinned connection too', async () => {
    const t = await setup();
    const dana = await connect(app.accounts, {
      cookie: t.dana.cookie,
      workspaceId: t.sales.id,
      resource: address(t.sales.id),
    });
    const listed = await callTool(dana.access_token, 'list_workspaces', {}, pinned(t.sales.id));
    const { workspaces } = JSON.parse(listed.text) as Listed;
    expect(workspaces.map(({ id, role, current }) => ({ id, role, current }))).toEqual([
      { id: t.sales.id, role: 'editor', current: true },
    ]);
  });

  it('answers nothing once the consent is gone', async () => {
    const t = await setup();
    const dana = await connect(app.accounts, { cookie: t.dana.cookie, workspaceId: t.sales.id });
    const [row] = await db.owner<{ workspace_id: string }[]>`
      select * from retainer_token_workspaces(${t.dana.userId}, ${t.sales.id}, ${CLAUDE_CLIENT_ID})`;
    expect(row?.workspace_id).toBe(t.sales.id);
    await db.owner`delete from oauth_consents where user_id = ${t.dana.userId}`;
    expect(
      await db.owner`
        select * from retainer_token_workspaces(${t.dana.userId}, ${t.sales.id}, ${CLAUDE_CLIENT_ID})`,
    ).toHaveLength(0);
    expect(await status(dana.access_token)).toBe(401);
  });

  it('gives an API key only its own workspace', async () => {
    const t = await setup();
    const { key } = await createApiKey(db.owner, {
      workspace: t.support.id,
      name: 'support-agent',
      actor: { type: 'agent', id: 'support-agent', name: 'Support agent' },
      scopes: ['read'],
    });
    const listed = await callTool(key, 'list_workspaces', {});
    const { workspaces } = JSON.parse(listed.text) as Listed;
    expect(workspaces).toEqual([
      { id: t.support.id, name: 'Support', current: true, address: address(t.support.id) },
    ]);
  });
});
