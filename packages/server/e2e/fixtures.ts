import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { test as base, expect } from '@playwright/test';
import { createAgentApp } from '@retainer/agent/runtime';
import { ENRICHMENT, ENRICHMENT_BINDINGS } from '@retainer/runner/enrichment-contract';
import { tamlootManifest } from '@retainer/runner/tamloot-contract';
import { generateKeyPair } from 'jose';
import postgres from 'postgres';
import { FakeAnthropic } from '../../agent/test/fake-anthropic.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { type ClaimedJob, ExtensionQueue } from '../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../src/extension-runtime/secrets.js';
import { RunTokens } from '../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../src/extensions/catalog.js';
import { parseOAuthClients } from '../src/extensions/oauth-clients.js';
import { createFileServer, LocalFileStorage } from '../src/file-storage/local.js';
import { consolidateWorkspace } from '../src/worker/consolidate.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
import {
  extensionFixture as manifestFixture,
  ownedTestFields,
} from '../test/helpers/extensions.js';
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
  bindings: [
    ownedTestFields('company', 'Companies', [
      {
        description: 'Fixture description.',
        universalId: '2384b956-709d-4edc-8aab-807c51027565',
        name: 'fixtureStatus',
        label: 'Fixture status',
        type: 'text',
      },
    ]),
  ],
});
export const browserStandaloneManifest = manifestFixture({
  universalId: '671f8022-4cb5-4a53-8633-110a89a69dc7',
  name: 'browser-app',
  execution: 'standalone',
  scopes: ['read', 'write'],
});
/** A hosted release that binds to company fields. */
export const browserMappingManifest = manifestFixture({
  universalId: 'c3b4d6e2-6a53-4b8c-9f1e-2d7a8b9c0e14',
  name: 'browser-enrichment',
  requestedActor: 'agent',
  scopes: ['read', 'write'],
  bindings: [
    {
      key: 'company',
      label: 'Companies',
      description: 'Fill in details on existing companies.',
      class: 'entity',
      access: 'write',
      required: true,
      fields: [
        {
          description: 'Fixture description.',
          key: 'domain',
          label: 'Domain',
          types: ['links'],
          required: true,
          lookup: true,
        },
        {
          key: 'employee_count',
          label: 'Employee count',
          required: false,
          types: ['number'],
          description: 'Employees the provider finds, mostly from public profiles.',
          create: {
            description: 'Fixture description.',
            universalId: '7d1a4c55-2b8e-4f0a-9c63-5e8f1a2b3c4d',
            name: 'employeeCount',
            label: 'Employee Count',
            type: 'number',
          },
        },
        {
          key: 'headquarters',
          label: 'Headquarters',
          required: false,
          types: ['address'],
          description: 'Headquarters city and country.',
        },
      ],
    },
  ],
});
/** Exa's full field list, without a live provider connection. */
export const browserExaMappingManifest = manifestFixture({
  universalId: ENRICHMENT.registration,
  name: 'exa-enrichment',
  requestedActor: 'agent',
  scopes: ['read', 'write'],
  bindings: ENRICHMENT_BINDINGS,
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
const browserSecretConfigureManifest = manifestFixture({
  ...browserConfigureManifest,
  settings: {
    providerKey: {
      type: 'string',
      label: 'Provider key',
      secret: true,
      required: true,
      reconnect: true,
    },
  },
  functions: browserConfigureManifest.functions.map((fn) => ({ ...fn, secrets: ['providerKey'] })),
});
const browserConfigurePrevious = manifestFixture({
  ...browserMappingManifest,
  name: 'browser-configure',
  bindings: browserMappingManifest.bindings?.map((binding) => ({
    ...binding,
    fields: binding.fields.filter((field) => field.key !== 'headquarters'),
  })),
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
const generatedSecret = (label: string) => ({
  type: 'string' as const,
  label,
  level: 'connection' as const,
  secret: true,
  generated: true,
  required: false,
  reconnect: false,
});
/** A member extension members connect with OAuth (Tamloot connect spec 4). */
export const browserOAuthManifest = manifestFixture({
  universalId: '5b0f3c1e-2a43-4d7e-9a61-6c2f1d0e8b47',
  name: 'oauth-browser',
  connection: 'member',
  scopes: ['read', 'write'],
  settings: {
    ...browserMemberManifest.settings,
    apiKey: {
      type: 'string',
      label: 'Member API key',
      level: 'connection',
      required: false,
      secret: true,
      reconnect: true,
    },
    verifier: generatedSecret('Verifier'),
    code: generatedSecret('Code'),
    tokens: generatedSecret('Tokens'),
  },
  oauth: {
    verifierSetting: 'verifier',
    codeSetting: 'code',
    tokenSetting: 'tokens',
    keySetting: 'apiKey',
    revokeUrl: 'https://provider.test/settings/apps',
  },
  functions: [
    {
      universalId: '0f2b7d5c-8e14-4a39-b6d2-3c9e1a7f5048',
      name: 'connect',
      description: 'Browser OAuth member setup',
      handlerDigest: 'c'.repeat(64),
      trigger: { kind: 'connect' },
      inputSchema: { type: 'object', additionalProperties: false },
      timeoutSeconds: 120,
      secrets: ['apiKey', 'verifier', 'code', 'tokens'],
    },
    {
      universalId: '7c4e9a21-5d36-4f8b-a0e3-2b8d6f1c9e75',
      name: 'disconnect',
      description: 'Browser OAuth member release',
      handlerDigest: 'd'.repeat(64),
      trigger: { kind: 'disconnect' },
      inputSchema: { type: 'object', additionalProperties: false },
      timeoutSeconds: 120,
      secrets: ['tokens'],
    },
  ],
});
const AGENT_RUNTIME_SECRET = 'browser-agent-runtime-secret-0123456789abcdef';
/** Where the fixture's provider sends members to approve; tests route it. */
export const BROWSER_OAUTH_AUTHORIZE = 'https://provider.test/oauth/start';
export const test = base.extend<
  {
    routineFixture: boolean;
    /** Runs the agent runtime beside the server, answering from a fake Anthropic API. */
    agentFixture: boolean;
    workspaceTemplate: 'starter' | 'sales';
    retainer: {
      url: string;
      /** The fake model behind the agent (`agentFixture`): queue its answers. */
      anthropic: FakeAnthropic | undefined;
      keys: { user: string; writer: string; agent: string; reader: string; other: string };
      restrictReads: (active: boolean) => void;
      request: (path: string, body?: unknown, key?: string, method?: string) => Promise<any>;
      /** Runs the consolidator once, which suggests merges. */
      consolidate: () => Promise<unknown>;
      activateMembers: () => Promise<void>;
      /** Installs the OAuth member fixture as the admin; returns its ID. */
      installOAuthMember: () => Promise<string>;
      finishConfigure: (setup?: boolean) => Promise<void>;
      /** Saves the suggestions Tamloot's model would make for the starter workspace. */
      suggestTamloot: () => Promise<void>;
      previousConfiguration: () => Promise<string>;
      expireConfigurationSecrets: () => Promise<void>;
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
    oauthMemberFixture: boolean;
    configureFixture: boolean;
    configureSecretFixture: boolean;
    tamlootFixture: boolean;
  }
>({
  routineFixture: [false, { option: true }],
  agentFixture: [false, { option: true }],
  workspaceTemplate: ['starter', { option: true }],
  extensionFixture: [false, { option: true, scope: 'worker' }],
  standaloneFixture: [false, { option: true, scope: 'worker' }],
  fileStorage: [false, { option: true, scope: 'worker' }],
  sourceFixture: [false, { option: true, scope: 'worker' }],
  mappingFixture: [false, { option: true, scope: 'worker' }],
  configureSecretFixture: [false, { option: true, scope: 'worker' }],
  configureFixture: [false, { option: true, scope: 'worker' }],
  tamlootFixture: [false, { option: true, scope: 'worker' }],
  memberFixture: [false, { option: true, scope: 'worker' }],
  oauthMemberFixture: [false, { option: true, scope: 'worker' }],
  retainer: async (
    {
      browserName: _browserName,
      extensionFixture,
      routineFixture,
      agentFixture,
      workspaceTemplate,
      standaloneFixture,
      fileStorage: withFiles,
      sourceFixture,
      mappingFixture,
      memberFixture,
      oauthMemberFixture,
      configureFixture,
      configureSecretFixture,
      tamlootFixture,
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
    const workspace = await createWorkspace(owner, { name: 'Acme', template: workspaceTemplate }),
      other = await createWorkspace(owner, { name: 'Other workspace', template: 'starter' });
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
    const memberManifest = memberFixture
      ? browserMemberManifest
      : oauthMemberFixture
        ? browserOAuthManifest
        : undefined;
    const tamloot = tamlootFixture
      ? tamlootManifest({
          packageDigest: 'a'.repeat(64),
          handlerDigest: 'b'.repeat(64),
          serverRange: '>=0.1.0 <0.2.0',
        })
      : undefined;
    const catalog = tamloot
      ? new ExtensionCatalog([
          { manifest: tamloot, actorCeiling: 'integration', runtimeEnabled: true },
        ])
      : configureFixture || configureSecretFixture
        ? new ExtensionCatalog(
            [
              browserConfigurePrevious,
              configureSecretFixture ? browserSecretConfigureManifest : browserConfigureManifest,
            ].map((manifest) => ({
              manifest,
              actorCeiling: 'agent',
              runtimeEnabled: true,
            })),
          )
        : sourceFixture
          ? new ExtensionCatalog([
              { manifest: sourceManifest, actorCeiling: 'integration', runtimeEnabled: true },
            ])
          : memberManifest
            ? new ExtensionCatalog([
                {
                  manifest: memberManifest,
                  actorCeiling: 'integration',
                  runtimeEnabled: true,
                },
              ])
            : undefined;
    const secretSql =
      memberManifest || configureSecretFixture || tamloot
        ? createSql(dbUrl.toString(), { role: 'retainer_secret_broker' })
        : undefined;
    const extensionSecrets = secretSql
      ? new SecretBroker(
          secretSql,
          new SecretCipher('browser', new Map([['browser', randomBytes(32)]])),
        )
      : undefined;
    const pair =
      routineFixture ||
      sourceFixture ||
      memberFixture ||
      oauthMemberFixture ||
      configureFixture ||
      configureSecretFixture ||
      tamloot
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
    // The OAuth redirect address needs the port, so listen before the app exists.
    let handle: (request: Request) => Response | Promise<Response> = () =>
      new Response('starting', { status: 503 });
    const server = serve({ fetch: (request) => handle(request), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listening address');
    const url = `http://127.0.0.1:${address.port}`;
    fileOrigins.push(url);
    // The agent runtime as self-hosted (agent spec §13): the server forwards each
    // stream to it, and it calls back the server's runtime routes.
    const anthropic = agentFixture ? await new FakeAnthropic().start() : undefined;
    let agentServer: ReturnType<typeof serve> | undefined;
    let agentUrl: string | undefined;
    if (anthropic) {
      process.env.ANTHROPIC_BASE_URL = anthropic.url;
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const agentApp = createAgentApp({
        apiOrigin: url,
        runtimeSecret: AGENT_RUNTIME_SECRET,
        mastraUrl: dbUrl.toString(),
        pollIntervalMs: 500,
      });
      agentServer = serve({ fetch: agentApp.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((r) => agentServer?.once('listening', () => r()));
      const agentAddress = agentServer.address();
      if (!agentAddress || typeof agentAddress === 'string') throw new Error('No agent address');
      agentUrl = `http://127.0.0.1:${agentAddress.port}`;
    }
    const app = createApp({
      sql,
      ...(agentUrl
        ? {
            agent: {
              runtimeSecret: AGENT_RUNTIME_SECRET,
              upstream: agentUrl,
              readStoreUrl: dbUrl.toString(),
            },
          }
        : {}),
      ...(routineFixture && runTokens ? { routines: { available: true }, runTokens } : {}),
      ...(oauthMemberFixture && catalog
        ? {
            extensionOAuthClients: parseOAuthClients(
              JSON.stringify({
                [browserOAuthManifest.universalId]: {
                  clientId: 'browser-client',
                  clientSecret: 'browser-secret',
                  authorizationEndpoint: BROWSER_OAUTH_AUTHORIZE,
                  tokenEndpoint: 'https://provider.test/oauth/token',
                },
              }),
              catalog,
              url,
            ),
          }
        : {}),
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
                ? [
                    { manifest: browserMappingManifest, actorCeiling: 'agent' as const },
                    { manifest: browserExaMappingManifest, actorCeiling: 'agent' as const },
                  ]
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
    let readers: ReturnType<typeof createSql> | undefined;
    let restricted: ReturnType<typeof createApp> | undefined;
    function restrictReads(active: boolean) {
      if (active && !restricted) {
        readers = createSql(dbUrl.toString(), { role: RUNTIME_ROLE, readOnly: true });
        restricted = createApp({
          sql: readers,
          webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
          restricted: { rateLimit: async (_c, next) => next() },
        });
      }
      handle = (request) => (active && restricted ? restricted : app).fetch(request);
    }
    restrictReads(false);
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
    /** Claims the newest queued `configure` job, as the runner would, with its run token. */
    async function claimConfigure(registrationId: string) {
      if (!catalog || !runTokens) throw new Error('no extension runtime in this fixture');
      const queue = new ExtensionQueue(sql, catalog.runtime);
      const [pending] =
        await owner`select id from extension_jobs where status='queued' and trigger_kind='configure' order by id desc limit 1`;
      if (!pending) throw new Error('no configure job');
      const job = await queue.claim(workspace.id, pending.id, randomUUID());
      if (!job) throw new Error('configure claim failed');
      const token = await runTokens.issue(sql, job, registrationId, job.scopes);
      return { queue, job, token };
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
      const { job, token } = await claimConfigure(browserConfigureManifest.universalId);
      if (configureSecretFixture) {
        const secret = await request(
          `/extensions/${job.installationId}/runtime/secrets/providerKey`,
          undefined,
          token,
        );
        if (!secret.value) throw new Error('target secret is missing');
      }
      const [existingCount] = await owner`
        select 1 from fields f join object_types o on o.id = f.object_type_id
        where o.workspace_id = ${workspace.id} and o.name_singular = 'company'
          and f.name = 'employeeCount' and f.status = 'active'`;
      await request(
        `/extensions/${job.installationId}/runtime/suggestions`,
        {
          bindings: {
            company: {
              action: 'existing',
              objects: ['company'],
              fields: {
                employee_count: existingCount
                  ? { action: 'existing', field: 'employeeCount' }
                  : { action: 'create' },
                headquarters: { action: 'existing', field: 'address' },
              },
            },
          },
          bindingReasons: {
            'company.employee_count': 'A dedicated count field.',
            'company.headquarters': 'The existing company address.',
          },
        },
        token,
        'PUT',
      );
      await queue.complete(job, { status: 'succeeded' });
    }
    async function suggestTamloot() {
      if (!tamloot) throw new Error('tamloot fixture is not enabled');
      const { queue, job, token } = await claimConfigure(tamloot.universalId);
      await request(
        `/extensions/${job.installationId}/runtime/suggestions`,
        {
          bindings: {
            meeting: { action: 'existing', objects: ['conversation'] },
            task: {
              action: 'existing',
              objects: ['task'],
              fields: {
                title: { action: 'existing', field: 'title' },
                status: {
                  action: 'existing',
                  field: 'status',
                  values: { open: 'todo', done: 'done' },
                },
                person: { action: 'existing', field: 'person' },
              },
            },
            person: {
              action: 'existing',
              objects: ['person'],
              fields: {
                name: { action: 'existing', field: 'name' },
                emails: { action: 'existing', field: 'emails' },
              },
            },
          },
          bindingReasons: {
            meeting: 'Conversations already hold meetings, with a medium field.',
            task: 'Tasks are the to-dos people already track here.',
            'task.status': 'Open is To do and done is Done.',
            person: 'People are matched by their email addresses.',
          },
        },
        token,
        'PUT',
      );
      await queue.complete(job, { status: 'succeeded', code: 'suggestions_ready' });
    }
    async function previousConfiguration() {
      const manifest = browserConfigurePrevious;
      return install({
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
        bindings: { company: { action: 'existing', objects: ['company'] } },
      });
    }
    function installOAuthMember() {
      const manifest = browserOAuthManifest;
      return install({
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: { share: true },
      });
    }
    /** Installs a release as the admin and finishes its install job. */
    async function install(input: {
      registrationId: string;
      version: string;
      settings: Record<string, unknown>;
      bindings?: Record<string, unknown>;
    }) {
      if (!catalog) throw new Error('no extension catalog in this fixture');
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
        binding: 'conversation',
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
          event: {
            ...event,
            title: 'Edited provider note',
            content:
              'Dana: Thanks for joining. Shall we go over the renewal?\n' +
              'Source attendee: Yes. We need the quote before the end of the month.\n' +
              'Dana: I will send it by Friday.',
          },
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
        anthropic,
        keys: { user, writer, agent, reader, other: otherKey },
        request,
        restrictReads,
        consolidate: () => consolidateWorkspace(sql, workspace.id),
        sourceEvidence,
        activateMembers,
        installOAuthMember,
        finishConfigure,
        suggestTamloot,
        previousConfiguration,
        expireConfigurationSecrets: async () => {
          await owner`update extension_pending_secrets set expires_at=now()-interval '1 second' where workspace_id=${workspace.id} and consumed_at is null`;
        },
      });
    } finally {
      if (agentServer) {
        const closing = agentServer;
        await new Promise<void>((r) => {
          closing.close(() => r());
          // A stopped turn's stream can still be open: stop accepting, then close it.
          if ('closeAllConnections' in closing) closing.closeAllConnections();
        });
      }
      await anthropic?.stop();
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
      await readers?.end();
      await sql.end();
      await owner.end();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
});
export { expect };
