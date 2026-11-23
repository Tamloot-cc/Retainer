import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionInstallation } from '@retainer/extension';
import { pinnedMcpAddress } from '@retainer/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { createTestDatabase } from '../helpers/db.js';
import { extensionFixture, testCompanyBinding } from '../helpers/extensions.js';
import {
  authorize,
  connect,
  consent,
  fetchClientMetadata,
  mcpCall,
  type Tokens,
  token,
} from '../helpers/oauth.js';

const oauthBase = `${ORIGIN}/account/auth/oauth2`;

it('keeps pre-CLI grants, API keys and workspace data live across migration', async () => {
  const db = await createTestDatabase('template0');
  const folder = await mkdtemp(join(tmpdir(), 'retainer-before-cli-'));
  try {
    await cp(fileURLToPath(new URL('../../drizzle', import.meta.url)), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter(({ idx }) => idx <= 140);
    await writeFile(journalPath, JSON.stringify(journal));
    for (const extension of ['pg_trgm', 'btree_gin', 'unaccent'])
      await db.owner.unsafe(`create extension ${extension}`);
    // Isolate the adapter because it changes postgres.js's JSON and date parsers.
    await migrate(drizzle(db.connect()), { migrationsFolder: folder });

    const registration = startAccountsApp(db);
    const redirectUri = 'https://legacy.example/callback';
    const registered = await registration.accounts.request(`${oauthBase}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Legacy installation',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read write offline_access',
        resources: [`${ORIGIN}/v1`],
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: installationClient } = (await registered.json()) as { client_id: string };
    const manifest = extensionFixture({
      execution: 'standalone',
      scopes: ['read', 'write'],
      bindings: [testCompanyBinding],
      oauthClientId: installationClient,
    });
    const makeApp = () =>
      startAccountsApp(db, {
        fetchClientMetadata,
        extensionCatalog: new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]),
      });
    let app = makeApp();
    const person = await app.signIn();
    const created = await app.account('/account/workspaces', {
      cookie: person.cookie,
      method: 'POST',
      body: { name: 'Before CLI', template: 'sales' },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as { id: string };
    const web = (path: string, body: unknown) =>
      app.api.request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          cookie: person.cookie,
          origin: ORIGIN,
          'x-retainer-client': 'web',
          'x-retainer-workspace': workspace.id,
          'content-type': 'application/json',
          'idempotency-key': 'before-cli',
        },
        body: JSON.stringify(body),
      });
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const preview = await web('/v1/extensions/preview', input);
    expect(preview.status).toBe(200);
    const { planDigest } = (await preview.json()) as { planDigest: string };
    const installed = await web('/v1/extensions', { ...input, planDigest });
    expect(installed.status, await installed.clone().text()).toBe(201);
    const installation = (await installed.json()) as ExtensionInstallation;
    const legacyKey = await createApiKey(db.owner, {
      workspace: workspace.id,
      name: 'Legacy key',
      actor: { type: 'agent', id: 'legacy' },
      scopes: ['read', 'write'],
    });
    const keyHeaders = {
      authorization: `Bearer ${legacyKey.key}`,
      'content-type': 'application/json',
    };
    const record = await app.api.request(`${ORIGIN}/v1/objects/company/records`, {
      method: 'POST',
      headers: keyHeaders,
      body: JSON.stringify({ values: { name: 'Existing company' } }),
    });
    expect(record.status).toBe(201);
    const { id: recordId } = (await record.json()) as { id: string };

    const mcp = `${ORIGIN}/mcp`,
      pinned = pinnedMcpAddress(ORIGIN, workspace.id),
      rest = `${ORIGIN}/v1`;
    const baseGrant = await connect(app.accounts, {
      cookie: person.cookie,
      workspaceId: workspace.id,
      resource: mcp,
    });
    const pinnedGrant = await connect(app.accounts, {
      cookie: person.cookie,
      workspaceId: workspace.id,
      resource: pinned,
    });
    const authorizeInstallation = async () => {
      const flow = await authorize(app.accounts, {
        cookie: person.cookie,
        clientId: installationClient,
        redirectUri,
        resource: rest,
        scope: 'read offline_access',
      });
      const accepted = await consent(app.accounts, flow, {
        cookie: person.cookie,
        workspaceId: workspace.id,
        installationId: installation.id,
        expectedGeneration: installation.generation,
      });
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      const { url } = (await accepted.json()) as { url: string };
      const exchanged = await token(app.accounts, {
        grant_type: 'authorization_code',
        code: new URL(url).searchParams.get('code') ?? '',
        client_id: installationClient,
        redirect_uri: redirectUri,
        code_verifier: flow.verifier,
        resource: rest,
      });
      expect(exchanged.status, await exchanged.clone().text()).toBe(200);
      return (await exchanged.json()) as Tokens;
    };
    const installationGrant = await authorizeInstallation();
    const before =
      await db.owner`select id, reference_id, client_id from oauth_consents order by id`;

    await runMigrations(db.url);
    app = makeApp();
    expect(
      await db.owner`select id, reference_id, client_id from oauth_consents order by id`,
    ).toEqual(before);
    const refresh = async (grant: Tokens, resource: string, clientId: string) => {
      const response = await token(app.accounts, {
        grant_type: 'refresh_token',
        refresh_token: grant.refresh_token ?? '',
        client_id: clientId,
        resource,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as Tokens;
    };
    for (const [resource, grant] of [
      [mcp, baseGrant],
      [pinned, pinnedGrant],
    ] as const) {
      const client = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
      const renewed = await refresh(grant, resource, client);
      for (const access of [grant.access_token, renewed.access_token]) {
        const response = await mcpCall(
          app.api,
          access,
          'tools/list',
          {},
          new URL(resource).pathname,
        );
        expect(response.status).toBe(200);
      }
    }
    const renewed = await refresh(installationGrant, rest, installationClient);
    const read = (headers: Record<string, string>) =>
      app.api.request(`${ORIGIN}/v1/records/${recordId}`, { headers });
    for (const access of [installationGrant.access_token, renewed.access_token])
      expect((await read({ authorization: `Bearer ${access}` })).status).toBe(200);
    expect(await (await read(keyHeaders)).json()).toMatchObject({
      id: recordId,
      fields: { name: 'Existing company' },
    });
  } finally {
    await db.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
