import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { hostedClientId } from '@retainer/shared';
import { CLAUDE_CLIENT_ID, CLAUDE_REDIRECT } from '../test/helpers/oauth.js';
import { expect, test } from './accounts-fixtures.js';

test.use({ hostedOnboarding: true, withMicrosoft: false });

const DANA = { sub: 'hosted-dana', email: 'dana@example.test', name: 'Dana Cohen' };
const headers = (url: string) => ({ origin: url, 'x-retainer-client': 'web' });
const tool = (url: string, accessToken: string, name: string, args = {}) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  }).then(async (r) => {
    expect(r.status).toBe(200);
    const text = await r.text();
    return JSON.parse(
      text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5) ?? text,
    ).result;
  });

async function openAuthorization(
  page: Page,
  url: string,
  clientId = CLAUDE_CLIENT_ID,
  redirectUri = CLAUDE_REDIRECT,
) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${url}/mcp`,
    scope: 'read write schema:write offline_access',
  });
  await page.route(
    (u) => u.origin + u.pathname === redirectUri,
    (route) => route.fulfill({ body: 'Return to your agent' }),
  );
  await page.goto(`${url}/account/auth/oauth2/authorize?${query}`);
  return { verifier, state, clientId, redirectUri };
}

async function approve(
  page: Page,
  url: string,
  { verifier, state, clientId, redirectUri }: Awaited<ReturnType<typeof openAuthorization>>,
) {
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL((u) => u.origin + u.pathname === redirectUri);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(state);
  const exchanged = await fetch(`${url}/account/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${url}/mcp`,
    }),
  });
  expect(exchanged.status).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

async function capture(page: Page, name: string) {
  if (process.env.RETAINER_ONBOARDING_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.RETAINER_ONBOARDING_SCREENSHOTS}/${name}.png` });
  }
}

test('web first: copy the exact workspace, verify over MCP, and wait for the approved schema', async ({
  page,
  context,
  accounts: a,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${a.url}/app/`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await a.signIn(context, DANA);
  await page.reload();
  await expect(page.getByLabel('Template')).toHaveValue('');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  const copy = page.getByRole('button', { name: 'Copy setup prompt' });
  await expect(copy).toBeVisible();
  const setupUrl = page.url();
  await expect(page.getByRole('heading', { name: 'My workspace' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Records' })).toHaveCount(0);
  await capture(page, 'retainer-workspace-setup');
  await page.getByRole('button', { name: 'Rename workspace' }).click();
  await page.getByRole('textbox', { name: 'Workspace name' }).fill('Project workspace');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Project workspace' })).toBeVisible();
  const [workspace] = await a.owner`select id, slug from workspaces`;
  expect(workspace).toBeDefined();

  const additional = await context.request.post(`${a.url}/account/workspaces`, {
    headers: headers(a.url),
    data: { name: 'Other workspace' },
  });
  expect(additional.status()).toBe(201);
  const otherWorkspace = (await additional.json()) as { id: string };
  await copy.click();
  const prompt = await page.evaluate(() =>
    (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
  );
  expect(prompt).toContain(`ID: ${workspace?.id}`);
  expect(prompt).toContain('Project workspace');

  const otherBrowser = await page.context().browser()?.newContext();
  if (!otherBrowser || !workspace) throw new Error('missing browser or workspace');
  await a.signIn(otherBrowser, DANA);
  const consentPage = await otherBrowser.newPage();
  const flow = await openAuthorization(
    consentPage,
    a.url,
    hostedClientId(workspace.id, 'codex'),
    'http://127.0.0.1:37574/callback',
  );
  await expect(consentPage.getByRole('radio', { name: /Project workspace/ })).toBeChecked();
  await expect(consentPage.getByRole('radio', { name: /Other workspace/ })).toHaveCount(0);
  const wrong = await otherBrowser.request.post(`${a.url}/account/oauth/consent`, {
    headers: headers(a.url),
    data: {
      oauth_query: new URL(consentPage.url()).search.slice(1),
      accept: true,
      workspaceId: otherWorkspace.id,
    },
  });
  expect(wrong.status()).toBe(400);
  expect((await wrong.json()).error.code).toBe('wrong_workspace');
  expect(await a.owner`select id from oauth_consents`).toHaveLength(0);
  await capture(consentPage, 'retainer-agent-consent');
  const token = await approve(consentPage, a.url, flow);
  await otherBrowser.close();
  const schema = await tool(a.url, token, 'describe_schema');
  expect(schema.structuredContent).toMatchObject({
    workspace: { id: workspace?.id, initialized: false },
    objects: [],
  });
  const invalid = await tool(a.url, token, 'propose_schema_change', {
    operations: [{ op: 'rename_object', object: 'missing', nameSingular: 'project' }],
  });
  expect(invalid.isError).toBe(true);
  await expect(copy).toBeVisible();
  const proposal = await tool(a.url, token, 'propose_schema_change', {
    reason: 'The user approved projects',
    operations: [
      {
        op: 'create_object',
        object: {
          nameSingular: 'project',
          namePlural: 'projects',
          labelSingular: 'Project',
          labelPlural: 'Projects',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text', isUnique: true }],
        },
      },
    ],
  });
  expect(proposal.structuredContent, JSON.stringify(proposal.content)).toMatchObject({
    status: 'proposed',
  });
  await expect(copy).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schema change needs approval' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Records' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Records' }).getByText('Projects')).toBeVisible();
  await expect(copy).toHaveCount(0);
  expect(page.url()).toBe(setupUrl);
  await capture(page, 'retainer-after-first-schema');
});

test('agent first: sign in and provision, cancel, then reuse the same workspace on retry', async ({
  page,
  context,
  accounts: a,
}) => {
  const first = await openAuthorization(page, a.url);
  await expect(page).toHaveURL(/\/app\/oauth\/sign-in\?/);
  await a.signIn(context, DANA);
  await page.reload();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('radio', { name: /My workspace/ })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/error=access_denied/);
  expect(new URL(page.url()).searchParams.get('state')).toBe(first.state);
  expect(await a.owner`select id from oauth_consents`).toHaveLength(0);
  const rows = await a.owner`select id from workspaces`;
  expect(rows).toHaveLength(1);

  const retry = await openAuthorization(page, a.url);
  await expect(page.getByRole('radio', { name: /My workspace/ })).toBeChecked();
  const token = await approve(page, a.url, retry);
  expect((await tool(a.url, token, 'describe_schema')).structuredContent).toMatchObject({
    workspace: { id: rows[0]?.id, initialized: false },
    objects: [],
  });
  expect(await a.owner`select id from workspaces`).toEqual(rows);
});

test('shows the setup prompt to copy by hand when the browser blocks the clipboard', async ({
  page,
  context,
  accounts: a,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
    });
  });
  await page.goto(`${a.url}/app/`);
  await a.signIn(context, DANA);
  await page.reload();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Copy setup prompt' }).click();
  await expect(page.getByText('Select and copy the prompt below.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Setup prompt' })).toHaveValue(/ID: /);
});

test('hosted sign-up can copy Starter when creating the workspace', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, DANA);
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Template').selectOption('starter');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('group', { name: 'Records' }).getByText('People')).toBeVisible();
  const [workspace] = await a.owner`select id, templates, initialized_at from workspaces`;
  expect(workspace?.templates).toMatchObject([{ name: 'starter', version: 1 }]);
  expect(workspace?.initialized_at).toBeTruthy();
  const [email] = await a.owner`
    select is_unique from fields f join object_types o on o.id = f.object_type_id
    where o.workspace_id = ${workspace?.id} and o.name_singular = 'person' and f.name = 'emails'`;
  expect(email?.is_unique).toBe(true);
});

async function invite(owner: BrowserContext, url: string) {
  const response = await owner.request.post(`${url}/account/workspaces`, {
    headers: headers(url),
    data: { name: 'Team workspace', template: 'starter' },
  });
  expect(response.status()).toBe(201);
  const workspace = await response.json();
  const invited = await owner.request.post(
    `${url}/account/organizations/${workspace.organizationId}/invitations`,
    {
      headers: headers(url),
      data: {
        email: DANA.email,
        role: 'member',
        workspaces: [{ workspaceId: workspace.id, role: 'viewer' }],
      },
    },
  );
  expect(invited.status()).toBe(201);
  return workspace.id as string;
}

test('accepting a team invitation keeps the pending OAuth request and the team schema', async ({
  browser,
  page,
  context,
  accounts: a,
}) => {
  const owner = await browser.newContext();
  await a.signIn(owner, { email: 'owner@example.test', name: 'Riley Owner' });
  const team = await invite(owner, a.url);
  await owner.close();
  await a.signIn(context, DANA);
  const flow = await openAuthorization(page, a.url);
  await expect(page.getByText("You've been invited")).toBeVisible();
  expect(await a.owner`select id from workspaces`).toHaveLength(1);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Team workspace/ })).toBeChecked();
  const token = await approve(page, a.url, flow);
  expect((await tool(a.url, token, 'describe_schema')).structuredContent).toMatchObject({
    workspace: { id: team, initialized: true },
    objects: expect.arrayContaining([expect.objectContaining({ nameSingular: 'person' })]),
  });
  await page.goto(`${a.url}/app/`);
  await expect(page.getByRole('group', { name: 'Records' }).getByText('People')).toBeVisible();
  expect(await a.owner`select id from workspaces`).toHaveLength(1);
});
