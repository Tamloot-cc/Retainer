import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { test as base, expect } from '@playwright/test';
import { BASE_EVENT_TYPE_IDS, BASE_OBJECT_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import postgres from 'postgres';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { type ClaimedJob, ExtensionQueue } from '../src/extension-runtime/queue.js';
import { RunTokens } from '../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../src/extensions/catalog.js';
import { createFileServer, LocalFileStorage } from '../src/file-storage/local.js';
import { consolidateWorkspace } from '../src/worker/consolidate.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
import { extensionFixture as manifestFixture } from '../test/helpers/extensions.js';
import { sourceManifest } from './source-fixture.js';
export const browserExtensionManifest = manifestFixture({
  universalId: 'e0548bb1-47fd-4de8-8edc-759e26a61e36',
  name: 'browser-fixture',
  settings: {
    enabled: { type: 'boolean', label: 'Enabled', required: true, secret: false, reconnect: false },
  },
  schema: [
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.company,
      definition: {
        universalId: '2384b956-709d-4edc-8aab-807c51027565',
        name: 'fixtureStatus',
        label: 'Fixture status',
        type: 'text',
      },
    },
  ],
});
export const test = base.extend<
  {
    retainer: {
      url: string;
      keys: { user: string; writer: string; agent: string; reader: string; other: string };
      request: (path: string, body?: unknown, key?: string, method?: string) => Promise<any>;
      /** Runs the consolidator once, which suggests merges. */
      consolidate: () => Promise<unknown>;
      sourceEvidence: () => Promise<{
        personId: string;
        previousEventId: string;
        currentEventId: string;
      }>;
    };
  },
  { extensionFixture: boolean; fileStorage: boolean; sourceFixture: boolean }
>({
  extensionFixture: [false, { option: true, scope: 'worker' }],
  fileStorage: [false, { option: true, scope: 'worker' }],
  sourceFixture: [false, { option: true, scope: 'worker' }],
  retainer: async (
    { browserName: _browserName, extensionFixture, fileStorage: withFiles, sourceFixture },
    use,
  ) => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('DATABASE_URL is required');
    const name = `retainer_browser_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: false });
    await admin.unsafe(
      `create database "${name}" template "${process.env.RETAINER_BROWSER_TEMPLATE}"`,
    );
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${name}`;
    const owner = createSql(dbUrl.toString()),
      sql = createSql(dbUrl.toString(), { role: RUNTIME_ROLE });
    const workspace = await createWorkspace(owner, { name: 'Acme' }),
      other = await createWorkspace(owner, { name: 'Other workspace' });
    const user = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Dana',
        actor: { type: 'user', id: 'dana' },
        scopes: ['admin'],
      })
    ).key;
    const agent = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Inbox agent',
        actor: { type: 'agent', id: 'inbox' },
        scopes: ['read', 'write', 'schema:write'],
      })
    ).key;
    const writer = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Writer',
        actor: { type: 'user', id: 'writer' },
        scopes: ['read', 'write'],
      })
    ).key;
    const reader = (
      await createApiKey(owner, {
        workspace: workspace.id,
        name: 'Reader',
        actor: { type: 'user', id: 'reader' },
        scopes: ['read'],
      })
    ).key;
    const otherKey = (
      await createApiKey(owner, {
        workspace: other.id,
        name: 'Other user',
        actor: { type: 'user', id: 'other' },
        scopes: ['admin'],
      })
    ).key;
    const fileDirectory = withFiles
      ? await mkdtemp(join(tmpdir(), 'retainer-browser-files-'))
      : undefined;
    const fileOrigins: string[] = [];
    const fileKey = randomBytes(32);
    const byteServer = fileDirectory
      ? createFileServer({ directory: fileDirectory, key: fileKey, allowedOrigins: fileOrigins })
      : undefined;
    let storage: LocalFileStorage | undefined;
    if (byteServer) {
      await new Promise<void>((r) => byteServer.listen(0, '127.0.0.1', r));
      const a = byteServer.address();
      if (!a || typeof a === 'string') throw new Error('file address missing');
      storage = new LocalFileStorage(`http://127.0.0.1:${a.port}`, fileKey);
    }
    const catalog = sourceFixture
      ? new ExtensionCatalog([
          { manifest: sourceManifest, actorCeiling: 'integration', runtimeEnabled: true },
        ])
      : undefined;
    const pair = sourceFixture ? await generateKeyPair('EdDSA') : undefined;
    const runTokens = pair
      ? new RunTokens({
          issuer: 'https://retainer.test',
          keyId: 'browser',
          signingKey: pair.privateKey,
          verificationKey: pair.publicKey,
        })
      : undefined;
    const app = createApp({
      sql,
      ...(storage ? { fileStorage: storage } : {}),
      ...(catalog && runTokens
        ? {
            extensionCatalog: catalog,
            extensionActivation: new Set(catalog.list().map((r) => r.digest)),
            runTokens,
          }
        : {}),
      ...(extensionFixture
        ? {
            extensionCatalog: new ExtensionCatalog([
              { manifest: browserExtensionManifest, actorCeiling: 'integration' },
            ]),
          }
        : {}),
      webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listening address');
    const url = `http://127.0.0.1:${address.port}`;
    fileOrigins.push(url);
    async function request(
      path: string,
      body?: unknown,
      key = agent,
      method?: string,
    ): Promise<any> {
      const response = await fetch(`${url}/v1${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    }
    async function sourceEvidence() {
      if (!catalog || !runTokens) throw new Error('source fixture is not enabled');
      const manifest = sourceManifest,
        input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
      const preview = await request('/extensions/preview', input, user);
      const installed = await fetch(`${url}/v1/extensions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${user}`,
          'content-type': 'application/json',
          'Idempotency-Key': 'source-browser',
        },
        body: JSON.stringify({ ...input, planDigest: preview.planDigest }),
      });
      if (!installed.ok) throw new Error('source fixture install failed');
      const { id } = (await installed.json()) as { id: string },
        base = `/extensions/${id}`;
      const queue = new ExtensionQueue(sql, (id, version) => catalog.get(id, version).manifest);
      const token = (run: ClaimedJob) =>
        runTokens.issue(sql, run, manifest.universalId, run.scopes);
      const [setup] =
        await owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
      const setupRun = await queue.claim(workspace.id, setup?.id, 'browser-setup');
      if (!setupRun) throw new Error('setup missing');
      const { sourceAccountId } = await request(
        `${base}/source/verify`,
        { sharing: 'workspace', accountId: 'browser-provider' },
        await token(setupRun),
      );
      await queue.complete(setupRun, { status: 'succeeded' });
      const scan = await queue.enqueue(workspace.id, id, {
        functionId: '897a069d-ae57-44e9-820e-e2e8d231f605',
        input: {},
        dedupeKey: 'scan',
      });
      const scanRun = await queue.claim(workspace.id, scan.id, 'browser-scan');
      if (!scanRun) throw new Error('scan missing');
      const { sourceItemId } = await request(
        `${base}/source-items`,
        { sourceAccountId, externalId: 'browser-note' },
        await token(scanRun),
      );
      await queue.complete(scanRun, { status: 'succeeded' });
      const job = await queue.enqueue(workspace.id, id, {
        functionId: '8ce44dc0-f84b-4730-8cf3-2e4c8df70d77',
        input: { sourceItemId },
        dedupeKey: 'sync',
      });
      const run = await queue.claim(workspace.id, job.id, 'browser-sync');
      if (!run) throw new Error('sync missing');
      const key = await token(run),
        person = (
          await request(
            '/objects/person/records',
            { values: { name: 'Source attendee', emails: 'source-browser@fixture.test' } },
            user,
          )
        ).record;
      const event = {
        type: BASE_EVENT_TYPE_IDS.conversation,
        occurredAt: '2026-11-10T10:00:00Z',
        title: 'Original provider note',
        participants: [{ email: 'source-browser@fixture.test' }],
      };
      const first = await request(
        `${base}/source-events`,
        { sourceItemId, providerRevision: '1', expectedRevisionId: null, event },
        key,
      );
      const edited = await request(
        `${base}/source-events`,
        {
          sourceItemId,
          providerRevision: '2',
          expectedRevisionId: first.revisionId,
          event: { ...event, title: 'Edited provider note' },
        },
        key,
      );
      await queue.complete(run, { status: 'succeeded' });
      return {
        personId: person.id,
        previousEventId: first.eventId,
        currentEventId: edited.eventId,
      };
    }
    try {
      await use({
        url,
        keys: { user, writer, agent, reader, other: otherKey },
        request,
        consolidate: () => consolidateWorkspace(sql, workspace.id),
        sourceEvidence,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        // Canceled browser requests can leave active sockets open after the
        // assertions finish. Stop accepting first, then close those sockets.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      if (byteServer) {
        byteServer.closeAllConnections();
        await new Promise<void>((r) => byteServer.close(() => r()));
      }
      if (fileDirectory) await rm(fileDirectory, { recursive: true, force: true });
      await sql.end();
      await owner.end();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
});
export { expect };
