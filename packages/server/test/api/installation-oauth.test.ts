import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionInstallation } from '@retainer/extension';
import { RetainerClient } from '@retainer/sdk';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentInstallation } from '../../src/accounts/extensions.js';
import { CONTROL_ROLE, RUNTIME_ROLE } from '../../src/config.js';
import { createExtensionControlApp } from '../../src/extension-control/app.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createFileServer, LocalFileStorage } from '../../src/file-storage/local.js';
import { setOrganizationMember, setWorkspaceMember } from '../../src/workspaces/organizations.js';
import {
  type AccountsTestApp,
  AUTH_SECRET,
  ORIGIN,
  startAccountsApp,
} from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import {
  authorize,
  consent,
  mcpCall,
  type OAuthFlow,
  type Tokens,
  token,
} from '../helpers/oauth.js';

const db = useTestDatabase(),
  redirectUri = 'https://workspace-app.example/callback';
let app: AccountsTestApp, clientId: string, catalog: ExtensionCatalog;
let directory: string, fileServer: ReturnType<typeof createFileServer>;
const manifest = extensionFixture({ execution: 'standalone', scopes: ['read', 'write'] });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-standalone-oauth-'));
  const key = randomBytes(32);
  fileServer = createFileServer({ directory, key });
  await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', r));
  const address = fileServer.address();
  if (!address || typeof address === 'string') throw new Error('missing byte service');
  const fileStorage = new LocalFileStorage(`http://127.0.0.1:${address.port}`, key);
  const registration = startAccountsApp(db);
  const response = await registration.accounts.request(`${ORIGIN}/account/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Reviewed workspace app',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'read write offline_access',
      resources: [`${ORIGIN}/v1`],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  clientId = ((await response.json()) as { client_id: string }).client_id;
  manifest.oauthClientId = clientId;
  catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
  app = startAccountsApp(db, { extensionCatalog: catalog, fileStorage });
});
afterAll(async () => {
  await new Promise<void>((r) => fileServer.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function json<T = unknown>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}
async function setup() {
  const admin = await app.signIn(),
    other = await app.signIn();
  const workspace = await json<{ id: string; organizationId: string }>(
    await app.account('/account/workspaces', {
      cookie: admin.cookie,
      method: 'POST',
      body: { name: `OAuth ${randomUUID()}`, template: 'sales' },
    }),
    201,
  );
  const v1 = (path: string, method = 'GET', body?: unknown) =>
    app.api.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        'x-retainer-client': 'web',
        'x-retainer-workspace': workspace.id,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await json<{ planDigest: string }>(
    await v1('/v1/extensions/preview', 'POST', input),
  );
  const installation = await json<ExtensionInstallation>(
    await v1('/v1/extensions', 'POST', { ...input, planDigest: preview.planDigest }),
    201,
  );
  const begin = (cookie = admin.cookie, scope = 'read write offline_access') =>
    authorize(app.accounts, {
      cookie,
      clientId,
      redirectUri,
      scope,
      resource: `${ORIGIN}/v1`,
    });
  const approve = (flow: OAuthFlow, cookie = admin.cookie, generation = installation.generation) =>
    consent(app.accounts, flow, {
      cookie,
      workspaceId: workspace.id,
      installationId: installation.id,
      expectedGeneration: generation,
    });
  const exchange = async (flow: OAuthFlow, response: Response) => {
    const accepted = await json<{ url: string }>(response),
      callback = new URL(accepted.url);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe(flow.consentUrl.searchParams.get('state'));
    return token(app.accounts, {
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: flow.verifier,
      resource: `${ORIGIN}/v1`,
    });
  };
  const connect = async (scope?: string) => {
    const flow = await begin(admin.cookie, scope);
    return (await json(await exchange(flow, await approve(flow)))) as Tokens;
  };
  const request = (access: string, path = '/v1/me', method = 'GET', body?: unknown) =>
    app.api.request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const refresh = (tokens: Tokens, resource = `${ORIGIN}/v1`) =>
    token(app.accounts, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token ?? '',
      client_id: clientId,
      resource,
    });
  return {
    admin,
    other,
    workspace,
    installation,
    v1,
    begin,
    approve,
    exchange,
    connect,
    request,
    refresh,
  };
}

describe('standalone workspace OAuth with real consent, PKCE, JWT and RLS', () => {
  it('supports the Tamloot transcript and forms-submission SDK contract with immutable attachments and retry identity', async () => {
    const h = await setup(),
      tokens = await h.connect();
    const sdk = new RetainerClient({
      baseUrl: ORIGIN,
      apiKey: tokens.access_token,
      fetch: async (url, init) => app.api.request(String(url), init),
    });
    const submission = { values: { name: 'Form submission company' } };
    const [first, retry] = await Promise.all([
      sdk.createRecord('company', submission, 'form-42'),
      sdk.createRecord('company', submission, 'form-42'),
    ]);
    expect(first.record.id).toBe(retry.record.id);
    await json(
      await h.v1('/v1/schema/changes', 'POST', {
        operations: [
          {
            op: 'create_field',
            object: 'conversation',
            field: { name: 'transcripts', label: 'Transcripts', type: 'files' },
          },
        ],
      }),
    );
    const bytes = Buffer.from('Tamloot transcript fixture: full recording text.');
    const intent = await sdk.createFileIntent(
      {
        name: 'meeting.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      'tamloot-recording-42-transcript',
    );
    expect(
      (
        await fetch(intent.upload.url, {
          method: 'PUT',
          headers: intent.upload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(201);
    await sdk.finalizeFile(intent.id);
    const event = {
      type: 'conversation',
      channel: 'tamloot:workspace-fixture',
      externalId: 'recording-42',
      title: 'Meeting',
      occurredAt: '2026-11-11T08:00:00Z',
      fields: { transcripts: [intent.id] },
      about: [first.record.id],
    };
    const logged = await sdk.logEvent(event),
      loggedAgain = await sdk.logEvent(event);
    expect(loggedAgain.id).toBe(logged.id);
    expect(loggedAgain.created).toBe(false);
    await expect(
      sdk.logEvent({ ...event, title: 'Changed original payload' }),
    ).rejects.toMatchObject({ status: 409 });
    const download = await sdk.downloadFile(intent.id);
    expect(await (await fetch(download.url)).text()).toBe(bytes.toString());
    const [stored] = await db.owner`select installation_id from files where id=${intent.id}`;
    expect(stored?.installation_id).toBe(h.installation.id);
    const [assertion] =
      await db.owner`select actor from field_assertions where record_id=${logged.id} limit 1`;
    expect(assertion?.actor).toMatchObject({ type: 'integration', id: h.installation.id });
  });
  it('uses the reviewed actor and scope for REST, refreshes, and keeps MCP/person memory separate', async () => {
    const h = await setup(),
      tokens = await h.connect();
    expect(tokens.refresh_token).toBeTruthy();
    const claims = decodeJwt(tokens.access_token);
    expect(claims).toMatchObject({
      aud: `${ORIGIN}/v1`,
      azp: clientId,
      sub: h.admin.userId,
      workspace_id: h.workspace.id,
      installation_id: h.installation.id,
      grant_generation: 1,
    });
    expect(claims.grant_id).toMatch(/^[a-f0-9-]{36}$/);
    const me = await json(await h.request(tokens.access_token));
    expect(me).toMatchObject({
      person: false,
      actor: { type: 'integration', id: h.installation.id },
      scopes: ['read', 'write'],
    });
    expect((await h.request(tokens.access_token, '/v1/records/me/context')).status).toBe(422);
    expect((await mcpCall(app.api, tokens.access_token, 'tools/list')).status).toBe(401);
    const created = await json<{ record: { id: string } }>(
      await h.request(tokens.access_token, '/v1/objects/company/records', 'POST', {
        values: { name: 'App company' },
      }),
      201,
    );
    const [assertion] =
      await db.owner`select actor from field_assertions where record_id=${created.record.id}`;
    expect(assertion?.actor).toMatchObject({ type: 'integration', id: h.installation.id });
    const [change] =
      await db.owner`select origin_installation_id,cause from record_changes where record_id=${created.record.id}`;
    expect(change).toMatchObject({
      origin_installation_id: h.installation.id,
      cause: [h.installation.id],
    });
    const refreshed = await json<Tokens>(await h.refresh(tokens));
    expect((await h.request(refreshed.access_token)).status).toBe(200);
    expect(
      await json(await app.account('/account/connections', { cookie: h.admin.cookie })),
    ).toEqual({ connections: [] });
    const listed = await json<{ credentials: unknown[] }>(
      await h.v1(`/v1/extensions/${h.installation.id}/credentials`),
    );
    expect(listed.credentials).toHaveLength(1);
    expect(listed.credentials[0]).toMatchObject({
      id: claims.grant_id,
      kind: 'oauth',
      active: true,
      clientId,
    });
    expect(JSON.stringify(listed)).not.toContain(tokens.refresh_token);
    const dedicated = createExtensionControlApp({
      sql: db.connect({ role: RUNTIME_ROLE }),
      publicOrigin: ORIGIN,
      accountsSecret: AUTH_SECRET,
      extensionCatalog: catalog,
    });
    expect(
      (
        await dedicated.request(`${ORIGIN}/v1/extensions/${h.installation.id}`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await dedicated.request(`${ORIGIN}/v1/extensions/${h.installation.id}/keys`, {
          method: 'POST',
          headers: {
            cookie: h.admin.cookie,
            origin: ORIGIN,
            'x-retainer-client': 'web',
            'x-retainer-workspace': h.workspace.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ expectedGeneration: 1, scopes: ['read'] }),
        })
      ).status,
    ).toBe(403);
  });
  it('requires admin approval of a pinned client and current generation, and denies forged queries without replacing a working grant', async () => {
    const h = await setup(),
      old = await h.connect();
    const flow = await h.begin();
    expect((await h.approve(flow, h.admin.cookie, h.installation.generation + 1)).status).toBe(409);
    flow.consentUrl.searchParams.set('state', 'tampered-state');
    expect((await h.approve(flow)).status).toBeGreaterThanOrEqual(400);
    expect((await h.request(old.access_token)).status).toBe(200);
    expect(
      await db.owner`select id from extension_credentials where installation_id=${h.installation.id} and pending`,
    ).toHaveLength(0);
    const email = (await db.owner`select email from users where id=${h.other.userId}`)[0]?.email;
    await setOrganizationMember(db.owner, {
      organization: h.workspace.organizationId,
      email,
      role: 'member',
    });
    for (const role of ['viewer', 'editor'] as const) {
      await setWorkspaceMember(db.owner, { workspace: h.workspace.id, email, role });
      expect((await h.approve(await h.begin(h.other.cookie), h.other.cookie)).status).toBe(403);
      expect(
        (
          await app.account(
            `/account/oauth/installations?workspaceId=${h.workspace.id}&client_id=${encodeURIComponent(clientId)}`,
            { cookie: h.other.cookie },
          )
        ).status,
      ).toBe(403);
    }
    const options = await json<{ installations: unknown[] }>(
      await app.account(
        `/account/oauth/installations?workspaceId=${h.workspace.id}&client_id=${encodeURIComponent(clientId)}`,
        { cookie: h.admin.cookie },
      ),
    );
    expect(options.installations[0]).toMatchObject({
      id: h.installation.id,
      generation: 1,
      actor: 'integration',
    });
    const missing = await h.begin();
    expect(
      (
        await consent(app.accounts, missing, {
          cookie: h.admin.cookie,
          workspaceId: h.workspace.id,
        })
      ).status,
    ).toBe(400);
  });
  it('keeps access after the approving admin leaves, then revokes JWTs and refresh tokens through workspace management', async () => {
    const h = await setup(),
      tokens = await h.connect();
    const email = (await db.owner`select email from users where id=${h.other.userId}`)[0]?.email;
    await setOrganizationMember(db.owner, {
      organization: h.workspace.organizationId,
      email,
      role: 'owner',
    });
    const removed = await app.account(
      `/account/organizations/${h.workspace.organizationId}/members/${h.admin.userId}`,
      { cookie: h.other.cookie, method: 'DELETE' },
    );
    expect(removed.status).toBe(204);
    expect((await h.request(tokens.access_token)).status).toBe(200);
    const refreshed = await json<Tokens>(await h.refresh(tokens));
    expect((await h.request(refreshed.access_token)).status).toBe(200);
    const id = decodeJwt(tokens.access_token).grant_id as string;
    const revoked = await app.v1(`/v1/extensions/${h.installation.id}/credentials/${id}`, {
      cookie: h.other.cookie,
      workspace: h.workspace.id,
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect((await h.request(tokens.access_token)).status).toBe(401);
    expect((await h.request(refreshed.access_token)).status).toBe(401);
    expect((await h.refresh(refreshed)).status).toBeGreaterThanOrEqual(400);
    expect(
      await db.owner`select id from oauth_grant_references where credential_id=${id}`,
    ).toHaveLength(0);
  });
  it('fences old tokens and refresh across disable/enable and explicit replacement; read-only remains read-only', async () => {
    const h = await setup(),
      tokens = await h.connect();
    expect((await h.v1(`/v1/extensions/${h.installation.id}/disable`, 'POST')).status).toBe(200);
    expect((await h.request(tokens.access_token)).status).toBe(401);
    expect((await h.refresh(tokens)).status).toBe(400);
    expect((await h.v1(`/v1/extensions/${h.installation.id}/enable`, 'POST')).status).toBe(200);
    expect((await h.request(tokens.access_token)).status).toBe(401);
    expect((await h.approve(await h.begin())).status).toBe(409);
    const current = await json<ExtensionInstallation>(
      await h.v1(`/v1/extensions/${h.installation.id}`),
    );
    h.installation.generation = current.generation;
    const fresh = await h.connect('read offline_access');
    expect((await h.request(fresh.access_token)).status).toBe(200);
    expect(
      (
        await h.request(fresh.access_token, '/v1/objects/company/records', 'POST', {
          values: { name: 'Denied' },
        })
      ).status,
    ).toBe(403);
    const replaced = await h.connect('read offline_access');
    expect((await h.request(fresh.access_token)).status).toBe(401);
    expect((await h.refresh(fresh)).status).toBeGreaterThanOrEqual(400);
    expect((await h.request(replaced.access_token)).status).toBe(200);
  });
  it('never activates a staged grant if the installation changes while the library records consent', async () => {
    const h = await setup(),
      tokens = await h.connect(),
      control = db.connect({ role: CONTROL_ROLE });
    const [user] = await db.owner`select id,name,email from users where id=${h.admin.userId}`;
    if (!user) throw new Error('test admin missing');
    const attempt = consentInstallation({
      sql: control,
      person: { id: user.id, name: user.name, email: user.email },
      workspaceId: h.workspace.id,
      installationId: h.installation.id,
      expectedGeneration: 1,
      grant: { clientId, scopes: ['read'] },
      catalog,
      record: async (referenceId) => {
        const [ref] =
          await control`select active from retainer_oauth_reference(${referenceId}::uuid)`;
        expect(ref?.active).toBe(false);
        expect((await h.v1(`/v1/extensions/${h.installation.id}/disable`, 'POST')).status).toBe(
          200,
        );
        return new Response('{}', { status: 200 });
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'stale_plan' });
    expect(
      await db.owner`select id from extension_credentials where installation_id=${h.installation.id} and pending`,
    ).toHaveLength(0);
    expect((await h.request(tokens.access_token)).status).toBe(401);
  });
  it('rejects even correctly signed tokens with mismatched client, subject, workspace, installation, reference, generation or audience', async () => {
    const h = await setup(),
      tokens = await h.connect(),
      claims = decodeJwt(tokens.access_token);
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' }),
      kid = randomUUID();
    await db.owner`insert into jwks(id,public_key,private_key,created_at,alg)
      values(${kid},${JSON.stringify(await exportJWK(publicKey))},'unused-test-private-key',clock_timestamp(),'EdDSA')`;
    try {
      const signed = (changes: Record<string, unknown>) =>
        new SignJWT({ ...claims, ...changes })
          .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
          .sign(privateKey);
      expect((await h.request(await signed({}))).status).toBe(200);
      for (const changes of [
        { azp: 'wrong-client' },
        { sub: randomUUID() },
        { workspace_id: randomUUID() },
        { installation_id: randomUUID() },
        { grant_id: randomUUID() },
        { grant_generation: 2 },
        { aud: `${ORIGIN}/mcp` },
        { aud: [`${ORIGIN}/v1`, `${ORIGIN}/mcp`] },
        { exp: 1 },
      ])
        expect((await h.request(await signed(changes))).status, JSON.stringify(changes)).toBe(401);
      const elevated = await json<{ scopes: string[] }>(
        await h.request(await signed({ scope: 'read write admin schema:write' })),
      );
      expect(elevated.scopes).toEqual(['read', 'write']);
    } finally {
      await db.owner`delete from jwks where id=${kid}`;
    }
  });
  it('checks PKCE, exact redirects, mixed resources and reviewed client binding before granting access', async () => {
    const h = await setup(),
      flow = await h.begin(),
      accepted = await json<{ url: string }>(await h.approve(flow));
    const code = new URL(accepted.url).searchParams.get('code') ?? '';
    for (const changes of [
      { code_verifier: 'wrong-verifier' },
      { redirect_uri: 'https://elsewhere.example/callback' },
      { resource: `${ORIGIN}/mcp` },
    ]) {
      const response = await token(app.accounts, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        code_verifier: flow.verifier,
        redirect_uri: redirectUri,
        resource: `${ORIGIN}/v1`,
        ...changes,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    const mixed = await h.begin();
    mixed.consentUrl.searchParams.append('resource', `${ORIGIN}/mcp`);
    expect((await h.approve(mixed)).status).toBe(400);
    const registration = await json<{ client_id: string }>(
      await app.accounts.request(`${ORIGIN}/account/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Unreviewed app',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
          resources: [`${ORIGIN}/v1`],
          scope: 'read',
        }),
      }),
      201,
    );
    const unreviewed = await authorize(app.accounts, {
      cookie: h.admin.cookie,
      clientId: registration.client_id,
      redirectUri,
      resource: `${ORIGIN}/v1`,
      scope: 'read',
    });
    expect((await h.approve(unreviewed)).status).toBe(409);
    const elsewhere = await setup();
    expect(
      (
        await consent(app.accounts, await elsewhere.begin(), {
          cookie: elsewhere.admin.cookie,
          workspaceId: elsewhere.workspace.id,
          installationId: h.installation.id,
          expectedGeneration: 1,
        })
      ).status,
    ).toBe(404);
  });
  it('serializes concurrent approvals so at most one current credential is usable', async () => {
    const h = await setup(),
      flows = await Promise.all([h.begin(), h.begin()]);
    const responses = await Promise.all(flows.map((flow) => h.approve(flow)));
    expect(responses.some((r) => r.ok)).toBe(true);
    expect(responses.every((r) => r.ok || r.status === 409)).toBe(true);
    const [active] = await db.owner`select count(*)::int as count from extension_credentials
      where installation_id=${h.installation.id} and not pending and revoked_at is null`;
    expect(active?.count).toBe(1);
    expect(
      await db.owner`select id from extension_credentials where installation_id=${h.installation.id} and pending`,
    ).toHaveLength(0);
  });
});
