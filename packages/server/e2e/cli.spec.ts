import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApiKey } from '../src/auth/keys.js';
import { expect, test } from './accounts-fixtures.js';

const invocation = promisify(execFile);
const bin = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));

test('the CLI logs in through loopback, elevates and records schema approval in History', async ({
  page,
  context,
  accounts,
}) => {
  const config = await mkdtemp(join(tmpdir(), 'retainer-cli-browser-'));
  try {
    async function run<T>(args: string[], exit = 0): Promise<T> {
      const result = await invocation(process.execPath, [bin, '--server', accounts.url, ...args], {
        env: { ...process.env, BROWSER: '/usr/bin/true', XDG_CONFIG_HOME: config },
        timeout: 12_000,
      }).then(
        ({ stdout }) => ({ code: 0, stdout }),
        (error: { code: number; stdout: string }) => error,
      );
      expect(result.code, result.stdout).toBe(exit);
      return JSON.parse(result.stdout) as T;
    }

    await accounts.signIn(context, { email: 'cli-owner@example.test', name: 'Dana Cohen' });
    await page.goto(`${accounts.url}/app/`);
    await page.getByLabel('Name your workspace').fill('CLI Sales');
    await page.getByLabel('Template').selectOption('starter');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/app\/w\/cli-sales-/);
    const workspaceUrl = page.url();
    const [workspace] = await accounts.owner<
      { id: string; slug: string }[]
    >`select id, slug from workspaces`;
    if (!workspace) throw new Error('the workspace did not initialize');

    const login = await run<{ id: string; url: string }>(['login'], 6);
    await page.goto(login.url);
    await expect(page.getByRole('heading', { name: /Connect the Retainer CLI on/ })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Retainer CLI is connected.')).toBeVisible();
    await expect(run(['wait', login.id])).resolves.toMatchObject({ status: 'done' });
    expect((await stat(join(config, 'retainer', 'credentials.json'))).mode & 0o777).toBe(0o600);
    await expect(run(['whoami', '--workspace', workspace.slug])).resolves.toMatchObject({
      user: { email: 'cli-owner@example.test' },
      workspace: { id: workspace.id },
    });

    const sequence = ['--workspace', workspace.slug];
    const key = await createApiKey(accounts.owner, {
      workspace: workspace.id,
      name: 'CLI browser fixture',
      actor: { type: 'agent', id: 'fixture' },
      scopes: ['schema:write'],
    });
    const proposal = await fetch(`${accounts.url}/v1/schema/changes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        reason: 'CLI browser approval fixture',
        operations: [{ op: 'rename_field', object: 'company', field: 'name', name: 'legalName' }],
      }),
    });
    const outcome = (await proposal.json()) as { change?: { id: string }; error?: unknown };
    expect(proposal.status, JSON.stringify(outcome)).toBe(202);
    if (!outcome.change) throw new Error('no proposal was created');

    const approve = ['schema-changes', 'approve', outcome.change.id, ...sequence];
    await expect(run(approve, 4)).resolves.toMatchObject({ error: 'elevation_required' });
    const elevation = await run<{ id: string; url: string }>(
      ['elevate', ...sequence, '--reason', 'review the company schema'],
      6,
    );
    await page.goto(elevation.url);
    await expect(page.getByText('review the company schema', { exact: false })).toBeVisible();
    if (process.env.RETAINER_CLI_SCREENSHOT_DIR) {
      await accounts.owner`update cli_logins set machine_name='Demo MacBook'`;
      await page.reload();
      await expect(page.getByText('Retainer CLI on Demo MacBook')).toBeVisible();
      await page.screenshot({
        path: join(process.env.RETAINER_CLI_SCREENSHOT_DIR, 'elevation.png'),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(process.env.RETAINER_CLI_SCREENSHOT_DIR, 'elevation-mobile.png'),
      });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Allowed. Return to the terminal.')).toBeVisible();
    await expect(run(['wait', elevation.id])).resolves.toMatchObject({ status: 'approved' });
    await expect(run(approve)).resolves.toMatchObject({ result: { status: 'applied' } });

    await page.goto(`${workspaceUrl}schema`);
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByText('Dana Cohen, through Retainer CLI')).toBeVisible();
    await run(['elevate', '--end', ...sequence]);
    await run(['logout']);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test('a passkey verifies the exact approval and step-up protects passkey changes', async ({
  page,
  context,
  accounts,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator is Chromium only');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await accounts.signIn(context, { email: 'cli-passkey@example.test', name: 'CLI Passkey' });
  await page.goto(`${accounts.url}/app/`);
  await page.getByLabel('Name your workspace').fill('CLI passkeys');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/cli-passkeys-/);
  const [workspace] = await accounts.owner<{ id: string }[]>`select id from workspaces`;
  const [person] = await accounts.owner<{ id: string }[]>`select id from users`;
  if (!workspace || !person) throw new Error('missing account fixtures');
  // Use the approvals table to isolate browser assertions from token issuance,
  // which the end-to-end login test covers through the detached CLI.
  const [login] = await accounts.owner<
    { id: string }[]
  >`insert into cli_logins (user_id,machine_name)
    values (${person.id}, 'Test Mac') returning id`;
  if (!login) throw new Error('missing CLI login');
  // Normally startup or the first CLI authorize request creates this client.
  await page.request.get(
    `${accounts.url}/account/auth/oauth2/authorize?${new URLSearchParams({
      client_id: 'retainer-cli',
      resource: `${accounts.url}/cli`,
      state: `${'a'.repeat(43)}.VGVzdCBNYWM`,
    })}`,
  );
  const approvals = await accounts.owner<{ id: string }[]>`insert into cli_approvals
    (login_id, kind, workspace_id, action, action_hash, expires_at)
    values (${login.id}, 'elevation', ${workspace.id}, '{"operation":"elevate","arguments":{"minutes":30}}', 'one', now()+interval '10 minutes'),
      (${login.id}, 'elevation', ${workspace.id}, '{"operation":"elevate","arguments":{"minutes":30}}', 'two', now()+interval '10 minutes')
    returning id`;
  const [first, second] = approvals;
  if (!first || !second) throw new Error('missing approval fixtures');

  await page.goto(`${accounts.url}/app/account`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText(/added/)).toHaveCount(1);
  const [enrolled] = await accounts.owner<{ id: string }[]>`select id from passkeys`;
  if (!enrolled) throw new Error('missing enrolled passkey');
  const passkey = enrolled.id;
  const rawDelete = await page.request.post(`${accounts.url}/account/auth/passkey/delete-passkey`, {
    data: { id: passkey },
    headers: { origin: accounts.url },
  });
  expect(rawDelete.ok()).toBe(false);
  expect(await accounts.owner`select id from passkeys`).toHaveLength(1);

  // A second registration must prove the existing key too. Hide the old key
  // from the virtual authenticator just until it has created a second key.
  const { credentials: existing } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const [credential] = existing;
  if (!credential) throw new Error('missing registered credential');
  await cdp.send('WebAuthn.removeCredential', {
    authenticatorId,
    credentialId: credential.credentialId,
  });
  await page.route(
    '**/account/passkeys/change-options',
    async (route) => {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText(/added/)).toHaveCount(2);

  const decide = (id: string, data: object) =>
    page.request.post(`${accounts.url}/account/cli/approvals/${id}/decide`, {
      data,
      headers: { origin: accounts.url, 'x-retainer-client': 'web' },
    });
  const withoutProof = await decide(first.id, { allow: true });
  expect(await withoutProof.json()).toMatchObject({ error: { code: 'passkey_required' } });
  const sessions = (await accounts.owner`select id from sessions`).length;
  await page.goto(`${accounts.url}/app/cli/approve/${first.id}`);
  const captured = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decide'));
  await page.getByRole('button', { name: 'Allow with passkey' }).click();
  const payload = (await captured).postDataJSON() as object;
  await expect(page.getByText('Allowed. Return to the terminal.')).toBeVisible();
  expect((await decide(second.id, payload)).ok()).toBe(false);
  expect((await decide(first.id, payload)).ok()).toBe(false);
  expect(await accounts.owner`select id from sessions`).toHaveLength(sessions);

  await page.goto(`${accounts.url}/app/account`);
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByText(/added/)).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('You have no passkeys yet.')).toBeVisible();
});

test('first-passkey registration cannot commit after another passkey was enrolled', async ({
  page,
  context,
  accounts,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator is Chromium only');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await accounts.signIn(context, { email: 'cli-passkey-race@example.test', name: 'Test person' });
  await page.goto(`${accounts.url}/app/account`);
  await expect(page.getByText('You have no passkeys yet.')).toBeVisible();
  const [user] = await accounts.owner<{ id: string }[]>`select id from users`;
  if (!user) throw new Error('missing user');
  // Pause the first registration after creation options and a browser
  // attestation, then commit another first key before releasing the request.
  await page.route(
    '**/account/auth/passkey/verify-registration',
    async (route) => {
      await accounts.owner`insert into passkeys (name,user_id,credential_id,public_key,counter,device_type,backed_up)
      values ('Other device', ${user.id}, 'b3RoZXItZGV2aWNl', 'AQID', 0, 'singleDevice', false)`;
      await route.continue();
    },
    { times: 1 },
  );
  const response = page.waitForResponse((r) => r.url().endsWith('/passkey/verify-registration'));
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  expect((await response).ok()).toBe(false);
  await expect(page.getByText('Other device')).toBeVisible();
  expect(await accounts.owner`select name from passkeys`).toEqual([{ name: 'Other device' }]);
});
