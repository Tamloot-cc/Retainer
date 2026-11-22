import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SchemaDescription } from '@retainer/shared';
import { beforeAll, expect, it } from 'vitest';
import { createOrganization, setOrganizationMember } from '../../src/workspaces/organizations.js';
import { upgradeWorkspaces } from '../../src/workspaces/upgrade.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import { authorize, connect, consent, fetchClientMetadata } from '../helpers/oauth.js';

const db = useTestDatabase();
let app: AccountsTestApp;

beforeAll(() => {
  app = startAccountsApp(db, { hostedOnboarding: true, fetchClientMetadata });
});

const ensure = (cookie: string, body: Record<string, unknown> = {}) =>
  app.account('/account/onboarding/workspace', { cookie, method: 'POST', body });
const workspaceOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { workspace: { id: string; slug: string } }).workspace;
};

it('discovers setup without sign-in or changing MCP authentication', async () => {
  const meta = await app.api.request('/.well-known/oauth-protected-resource/mcp');
  expect(await meta.json()).toMatchObject({ resource_documentation: `${ORIGIN}/mcp/setup` });
  const doc = await app.api.request('/mcp/setup');
  expect(await doc.text()).toMatch(/codex mcp add[\s\S]+claude mcp add[\s\S]+describe_schema/);
  const browser = await app.api.request('/mcp', { headers: { accept: 'text/html' } });
  expect(browser.headers.get('location')).toBe(`${ORIGIN}/mcp/setup`);
  const plain = await app.api.request('/mcp');
  expect(await plain.text()).toContain('Connect to hosted Retainer');
  const client = await app.api.request('/mcp', { headers: { accept: 'text/event-stream' } });
  expect(client.status).toBe(401);
  expect(client.headers.get('www-authenticate')).toContain('resource_metadata');
  expect(client.headers.get('link')).toContain('/mcp/setup');
});

it('provisions once across concurrent web and OAuth attempts, and never opens the workspace for a failed schema', async () => {
  const { cookie, userId } = await app.signIn();
  const flow = await authorize(app.accounts, { cookie });
  const badQuery = new URL(flow.consentUrl);
  badQuery.searchParams.set('exp', '1');
  expect((await ensure(cookie, { oauthQuery: badQuery.search.slice(1) })).status).toBe(400);
  expect(await db.owner`select 1 from organization_members where user_id = ${userId}`).toHaveLength(
    0,
  );

  const [web, agent] = await Promise.all([
    ensure(cookie),
    ensure(cookie, { oauthQuery: flow.consentUrl.search.slice(1) }),
  ]);
  const workspace = await workspaceOf(web);
  expect(await workspaceOf(agent)).toEqual(workspace);
  expect(await db.owner`select 1 from workspaces`).toHaveLength(1);

  const canceled = await consent(app.accounts, flow, { cookie, accept: false });
  expect(await canceled.json()).toMatchObject({ url: expect.stringContaining('access_denied') });
  expect(await db.owner`select 1 from oauth_consents`).toHaveLength(0);
  expect((await workspaceOf(await ensure(cookie))).id).toBe(workspace.id);

  // Force a definition upgrade; a deploy must not seed people or events into this workspace.
  await db.owner`update workspaces set definitions_digest = null where id = ${workspace.id}`;
  expect((await upgradeWorkspaces(db.owner)).failed).toEqual([]);

  const tokens = await connect(app.accounts, {
    cookie,
    workspaceId: workspace.id,
    scope: 'read write schema:write offline_access',
  });
  const client = new Client({ name: 'onboarding test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: async (input, init) => app.api.request(String(input), init),
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const readSchema = async () => {
    const result = await client.callTool({ name: 'describe_schema', arguments: {} });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as SchemaDescription;
  };
  try {
    expect(await readSchema()).toMatchObject({
      workspace: { id: workspace.id, initialized: false },
      objects: [],
    });
    const invalid = await client.callTool({
      name: 'propose_schema_change',
      arguments: {
        operations: [{ op: 'rename_object', object: 'missing', nameSingular: 'client' }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect((await readSchema()).workspace.initialized).toBe(false);
    const result = await client.callTool({
      name: 'propose_schema_change',
      arguments: {
        reason: 'Approved project schema',
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'project',
              namePlural: 'projects',
              labelSingular: 'Project',
              labelPlural: 'Projects',
              labelField: 'name',
              fields: [{ name: 'name', label: 'Name', type: 'text' }],
            },
          },
        ],
      },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const applied = await readSchema();
    expect(applied.workspace.initialized).toBe(true);
    expect(applied.objects.map((o) => o.nameSingular)).toEqual(['project']);
  } finally {
    await client.close();
  }
});

it('gives a pending invitation priority over creating an unrelated workspace', async () => {
  const owner = await app.signIn({ email: 'owner@hosted.test' });
  const invitee = await app.signIn({ email: 'invitee@hosted.test' });
  // Simulate a workspace created before hosted onboarding shipped.
  const organization = await createOrganization(db.owner, { name: 'Team' });
  await setOrganizationMember(db.owner, {
    organization: organization.id,
    email: 'owner@hosted.test',
    role: 'owner',
  });
  const team = await createWorkspace(db.owner, { name: 'Team', organization: organization.id });
  const invite = await app.account(`/account/organizations/${team.organizationId}/invitations`, {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      email: 'invitee@hosted.test',
      role: 'member',
      workspaces: [{ workspaceId: team.id, role: 'viewer' }],
    },
  });
  expect(invite.status).toBe(201);
  const { id } = (await invite.json()) as { id: string };
  expect(await (await ensure(invitee.cookie)).json()).toEqual({ workspace: null });
  expect(
    (
      await app.account(`/account/invitations/${id}/accept`, {
        method: 'POST',
        cookie: invitee.cookie,
      })
    ).status,
  ).toBe(200);
  expect((await workspaceOf(await ensure(invitee.cookie))).id).toBe(team.id);
  const schema = await app.v1('/v1/schema', { cookie: invitee.cookie, workspace: team.id });
  expect(await schema.json()).toMatchObject({
    workspace: { initialized: false },
    objects: [],
  });
});
