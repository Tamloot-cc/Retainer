import { randomBytes, randomUUID } from 'node:crypto';
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
import { SecretBroker, SecretCipher } from '../src/extension-runtime/secrets.js';
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
    signingSecret: {
      type: 'string',
      label: 'Generated signing secret',
      secret: true,
      generated: true,
      required: false,
      reconnect: false,
    },
    enabled: { type: 'boolean', label: 'Enabled', required: true, secret: false, reconnect: false },
    account: {
      type: 'string',
      label: 'Provider account',
      required: false,
      secret: false,
      reconnect: true,
    },
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
export const browserStandaloneManifest = manifestFixture({
  universalId: '671f8022-4cb5-4a53-8633-110a89a69dc7',
  name: 'browser-app',
  execution: 'standalone',
  scopes: ['read', 'write'],
});
/** A hosted release with an output mapping onto the base company object. */
export const browserMappingManifest = manifestFixture({
  universalId: 'c3b4d6e2-6a53-4b8c-9f1e-2d7a8b9c0e14',
  name: 'browser-enrichment',
  requestedActor: 'agent',
  scopes: ['read', 'write'],
  mapping: {
    objectId: BASE_OBJECT_IDS.company,
    lookup: { fieldId: 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641', type: 'links' },
    outputs: [
      {
        key: 'employee_count',
        label: 'Employee count',
        description: 'Employees the provider finds, mostly from public profiles.',
        types: ['number'],
        field: {
          universalId: '7d1a4c55-2b8e-4f0a-9c63-5e8f1a2b3c4d',
          name: 'employeeCount',
          label: 'Employee Count',
          type: 'number',
        },
      },
      {
        key: 'headquarters',
        label: 'Headquarters',
        description: 'Headquarters city and country.',
        types: ['address'],
      },
    ],
  },
});
export const browserConfigureManifest = manifestFixture({
  ...browserMappingManifest,
  name: 'browser-configure',
  version: '2.0.0',
  functions: [
    {
      universalId: '46966046-f236-48de-826f-27dd9e94d266',
      name: 'configure',
      description: 'Suggest field mapping',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'configure' },
      scopes: ['read'],
      secrets: [],
      timeoutSeconds: 120,
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
});
const browserMapping = browserMappingManifest.mapping;
if (!browserMapping) throw new Error('mapping fixture needs a mapping');
const browserConfigurePrevious = manifestFixture({
  ...browserMappingManifest,
  name: 'browser-configure',
  mapping: {
    ...browserMapping,
    outputs: browserMapping.outputs.slice(0, 1),
  },
});
export const browserMemberManifest = manifestFixture({
  universalId: 'd76ad98b-ac74-4fe5-82ac-0947165f8780',
  name: 'member-browser',
  connection: 'member',
  scopes: ['read', 'write'],
  settings: {
    share: {
      type: 'boolean',
      label: 'Share member data',
      required: true,
      consent: true,
      default: false,
      secret: false,
      reconnect: false,
    },
    days: {
      type: 'number',
      label: 'History days',
      level: 'connection',
      required: true,
      default: 31,
      secret: false,
      reconnect: false,
    },
    apiKey: {
      type: 'string',
      label: 'Member API key',
      level: 'connection',
      required: true,
      secret: true,
      reconnect: true,
    },
  },
  functions: [
    {
      universalId: 'de31f9cb-954f-4f93-bcca-b794e9372833',
      name: 'connect',
      description: 'Browser member setup',
      handlerDigest: 'a'.repeat(64),
      trigger: { kind: 'connect' },
      inputSchema: { type: 'object', additionalProperties: false },
      timeoutSeconds: 120,
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
      activateMembers: () => Promise<void>;
      finishConfigure: (setup?: boolean) => Promise<void>;
      previousConfiguration: () => Promise<string>;
      sourceEvidence: () => Promise<{
        personId: string;
        previousEventId: string;
        currentEventId: string;
      }>;
    };
  },
  {
    extensionFixture: boolean;
    standaloneFixture: boolean;
    fileStorage: boolean;
    sourceFixture: boolean;
    mappingFixture: boolean;
    memberFixture: boolean;
    configureFixture: boolean;
  }
>({
  extensionFixture: [false, { option: true, scope: 'worker' }],
  standaloneFixture: [false, { option: true, scope: 'worker' }],
  fileStorage: [false, { option: true, scope: 'worker' }],
  sourceFixture: [false, { option: true, scope: 'worker' }],
  mappingFixture: [false, { option: true, scope: 'worker' }],
  configureFixture: [false, { option: true, scope: 'worker' }],
  memberFixture: [false, { option: true, scope: 'worker' }],
  retainer: async (
    {
      browserName: _browserName,
      extensionFixture,
      standaloneFixture,
      fileStorage: withFiles,
      sourceFixture,
      mappingFixture,
      memberFixture,
      configureFixture,
    },
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
    const catalog = configureFixture
      ? new ExtensionCatalog(
          [browserConfigurePrevious, browserConfigureManifest].map((manifest) => ({
            manifest,
            actorCeiling: 'agent',
            runtimeEnabled: true,
          })),
        )
      : sourceFixture
        ? new ExtensionCatalog([
            { manifest: sourceManifest, actorCeiling: 'integration', runtimeEnabled: true },
          ])
        : memberFixture
          ? new ExtensionCatalog([
              {
                manifest: browserMemberManifest,
                actorCeiling: 'integration',
                runtimeEnabled: true,
              },
            ])
          : undefined;
    const secretSql = memberFixture
      ? createSql(dbUrl.toString(), { role: 'retainer_secret_broker' })
      : undefined;
    const extensionSecrets = secretSql
      ? new SecretBroker(
          secretSql,
          new SecretCipher('browser', new Map([['browser', randomBytes(32)]])),
        )
      : undefined;
    const pair =
      sourceFixture || memberFixture || configureFixture
        ? await generateKeyPair('EdDSA')
        : undefined;
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
      ...(extensionSecrets ? { extensionSecrets } : {}),
      ...(catalog && runTokens
        ? {
            extensionCatalog: catalog,
            extensionActivation: new Set(catalog.list().map((r) => r.digest)),
            runTokens,
          }
        : {}),
      ...(extensionFixture || standaloneFixture || mappingFixture
        ? {
            extensionCatalog: new ExtensionCatalog([
              ...(mappingFixture
                ? [{ manifest: browserMappingManifest, actorCeiling: 'agent' as const }]
                : []),
              ...(extensionFixture
                ? [{ manifest: browserExtensionManifest, actorCeiling: 'integration' as const }]
                : []),
              ...(standaloneFixture
                ? [{ manifest: browserStandaloneManifest, actorCeiling: 'integration' as const }]
                : []),
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
    async function finishConfigure(setup = false) {
      if (!catalog || !runTokens) throw new Error('configure fixture is not enabled');
      const queue = new ExtensionQueue(sql, catalog.runtime);
      if (setup) {
        const [pending] =
          await owner`select id from extension_jobs where workspace_id=${workspace.id} and status='queued' and trigger_kind='install' order by id desc limit 1`;
        if (!pending) throw new Error('no install job');
        const run = await queue.claim(workspace.id, pending.id, randomUUID());
        if (!run) throw new Error('install claim failed');
        await queue.complete(run, { status: 'succeeded' });
        return;
      }
      const [pending] =
        await owner`select id,installation_id from extension_jobs where status='queued' and trigger_kind='configure' order by id desc limit 1`;
      if (!pending) throw new Error('no configure job');
      const job = await queue.claim(workspace.id, pending.id, randomUUID());
      if (!job) throw new Error('configure claim failed');
      const token = await runTokens.issue(
        sql,
        job,
        browserConfigureManifest.universalId,
        job.scopes,
      );
      await request(
        `/extensions/${job.installationId}/runtime/suggestions`,
        {
          mapping: {
            employee_count: { action: 'create', reason: 'A dedicated count field.' },
            headquarters: {
              action: 'existing',
              field: 'address',
              reason: 'The existing company address.',
            },
          },
        },
        token,
        'PUT',
      );
      await queue.complete(job, { status: 'succeeded' });
    }
    async function previousConfiguration() {
      if (!catalog) throw new Error('configure fixture is not enabled');
      const manifest = browserConfigurePrevious;
      const input = {
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
        mapping: { employee_count: { action: 'create' } },
      };
      const preview = await request('/extensions/preview', input, user);
      const response = await fetch(`${url}/v1/extensions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${user}`,
          'content-type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ ...input, planDigest: preview.planDigest }),
      });
      const installed = (await response.json()) as { id: string };
      if (!response.ok) throw new Error(JSON.stringify(installed));
      const [pending] =
        await owner`select id from extension_jobs where installation_id=${installed.id} and trigger_kind='install'`;
      const queue = new ExtensionQueue(sql, catalog.runtime);
      const job = await queue.claim(workspace.id, pending?.id, randomUUID());
      if (!job) throw new Error('install claim failed');
      await queue.complete(job, { status: 'succeeded' });
      return installed.id;
    }
    async function activateMembers() {
      if (!memberFixture || !catalog || !runTokens)
        throw new Error('member fixture is not enabled');
      const queue = new ExtensionQueue(sql, catalog.runtime);
      for (const kind of ['install', 'connect']) {
        const jobs =
          await owner`select j.id,j.installation_id from extension_jobs j join extension_installations i on i.id=j.installation_id and i.generation=j.generation
          where j.workspace_id=${workspace.id} and i.registration_id=${browserMemberManifest.universalId} and j.status='queued' and j.trigger_kind=${kind} order by j.id`;
        for (const job of jobs) {
          const run = await queue.claim(workspace.id, job.id, `browser-member-${kind}`);
          if (!run) throw new Error('member fixture job missing');
          if (kind === 'connect') {
            const token = await runTokens.issue(sql, run, browserMemberManifest.universalId, [
              'read',
              'write',
            ]);
            const response = await fetch(
              `${url}/v1/extensions/${job.installation_id}/runtime/secrets/apiKey`,
              { headers: { authorization: `Bearer ${token}` } },
            );
            const body = await response.json();
            if (
              !response.ok ||
              typeof body !== 'object' ||
              body === null ||
              !('value' in body) ||
              typeof body.value !== 'string' ||
              !body.value
            )
              throw new Error('member secret round trip failed');
          }
          await queue.complete(run, { status: 'succeeded' });
          await queue.scheduleTick(workspace.id, job.installation_id);
        }
      }
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
      const queue = new ExtensionQueue(sql, catalog.runtime);
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
        activateMembers,
        finishConfigure,
        previousConfiguration,
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
      if (secretSql) await secretSql.end();
      await sql.end();
      await owner.end();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
});
export { expect };
