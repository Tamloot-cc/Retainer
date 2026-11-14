import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { granolaManifest } from '@retainer/runner/granola-contract';
import { RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createExtensionControlApp } from '../../src/extension-control/app.js';
import { extensionServices } from '../../src/extension-control/configuration.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
let t: TestApp, key: string;
beforeAll(async () => {
  t = startTestApp(db);
  key = (
    await t.setupWorkspace(
      { name: 'Runtime configuration' },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    )
  ).keys.admin;
});
const manifest = extensionFixture({
  settings: {
    apiKey: { type: 'string', label: 'API key', required: true, secret: true, reconnect: true },
  },
});
const catalog = JSON.stringify([{ manifest, actorCeiling: 'integration' }]);
describe('operator runtime configuration and dedicated key-mode control', () => {
  it('keeps the default catalog empty without creating brokers or workers', async () => {
    const services = await extensionServices(loadConfig({ DATABASE_URL: db.url }));
    try {
      expect(services.catalog.list()).toEqual([]);
      expect(services.tokens).toBeUndefined();
      expect(services.broker).toBeUndefined();
      expect(services.executor).toBeUndefined();
    } finally {
      await services.close();
    }
  });
  it.each([
    { kind: 'job', driver: 'launcher' },
    { kind: 'configure', driver: 'launcher' },
    { kind: 'job', driver: 'lambda' },
    { kind: 'configure', driver: 'lambda' },
  ] as const)(
    'activates $kind with $driver only when its complete immutable executable map matches',
    async ({ kind, driver }) => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const functionId = crypto.randomUUID();
      const manifest = extensionFixture({
        settings: {
          enabled: {
            type: 'boolean',
            label: 'Enabled',
            secret: false,
            required: false,
            reconnect: false,
          },
        },
        functions: [
          {
            universalId: functionId,
            name: 'job',
            description: 'Fixture',
            handlerDigest: 'b'.repeat(64),
            timeoutSeconds: 120,
            trigger: { kind },
            scopes: ['read'],
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
      });
      const release = new ExtensionCatalog([
        { manifest, actorCeiling: 'integration', runtimeEnabled: true },
      ]).list()[0];
      if (!release) throw new Error('release missing');
      const base = {
        DATABASE_URL: db.url,
        RETAINER_EXTENSION_DRIVER: driver,
        RETAINER_EXTENSION_LAMBDA_PREFIX:
          driver === 'lambda'
            ? 'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-'
            : undefined,
        RETAINER_EXTENSION_ISSUER: 'https://retainer.test',
        RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(publicKey.export({ format: 'jwk' })),
        RETAINER_EXTENSION_CATALOG: JSON.stringify([release].map(({ digest: _digest, ...r }) => r)),
      };
      const executable = {
        registrationId: manifest.universalId,
        releaseDigest: release.digest,
        functionId,
        handlerDigest: 'b'.repeat(64),
        packageDigest: manifest.packageDigest,
        runtimeVersion: 'node24',
        driverTarget:
          driver === 'lambda'
            ? 'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-fixture:42'
            : 'fixture',
      };
      await expect(
        extensionServices(loadConfig({ ...base, RETAINER_EXTENSION_EXECUTABLES: '[]' })),
      ).rejects.toThrow('configuration');
      await expect(
        extensionServices(
          loadConfig({
            ...base,
            RETAINER_EXTENSION_EXECUTABLES: JSON.stringify([
              { ...executable, handlerDigest: 'c'.repeat(64) },
            ]),
          }),
        ),
      ).rejects.toThrow('configuration');
      const ready = await extensionServices(
        loadConfig({ ...base, RETAINER_EXTENSION_EXECUTABLES: JSON.stringify([executable]) }),
      );
      try {
        expect([...ready.activationReady]).toEqual([release.digest]);
      } finally {
        await ready.close();
      }
      const inert = await extensionServices(
        loadConfig({ ...base, RETAINER_EXTENSION_RUN_PUBLIC_KEY: '' }),
      );
      try {
        expect(inert.activationReady.size).toBe(0);
      } finally {
        await inert.close();
      }
    },
  );
  it('serves preview/install and broker staging without accounts mode or sign-in control', async () => {
    const config = loadConfig({
      DATABASE_URL: db.url,
      RETAINER_ROLE: 'extensions',
      RETAINER_EXTENSION_CATALOG: catalog,
      RETAINER_EXTENSION_SECRET_KEYS: JSON.stringify({
        currentVersion: 'test',
        keys: { test: randomBytes(32).toString('base64') },
      }),
    });
    const services = await extensionServices(config, { broker: true });
    try {
      const control = createExtensionControlApp({
        sql: t.sql,
        extensionCatalog: services.catalog,
        extensionSecrets: services.broker,
      });
      const sdk = new RetainerClient({
        baseUrl: 'http://retainer.test',
        apiKey: key,
        fetch: (url, init) => Promise.resolve(control.request(String(url), init)),
      });
      expect((await sdk.extensionCatalog()).releases).toHaveLength(1);
      const stage = await control.request('/v1/extensions/secrets', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          registrationId: manifest.universalId,
          version: manifest.version,
          name: 'apiKey',
          value: 'fixture-key',
        }),
      });
      expect(stage.status).toBe(201);
      const reference = (await stage.json()) as { pendingSecretId: string };
      const input = {
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
        secretRefs: { apiKey: reference.pendingSecretId },
      };
      const preview = await sdk.previewExtension(input);
      expect(
        (
          await sdk.installExtension(
            { ...input, planDigest: preview.planDigest },
            'dedicated-install',
          )
        ).secrets,
      ).toEqual({ apiKey: true });
      expect((await control.request('/account/sign-in')).status).toBe(404);
    } finally {
      await services.close();
    }
  });
  it('loads asymmetric verification without a private key and sanitizes invalid operator inputs', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' }),
      privateJwk = privateKey.export({ format: 'jwk' });
    const base = {
      DATABASE_URL: db.url,
      RETAINER_EXTENSION_ISSUER: 'https://retainer.test',
      RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(publicJwk),
    };
    const services = await extensionServices(loadConfig(base));
    try {
      expect(services.tokens).toBeDefined();
    } finally {
      await services.close();
    }
    const sensitive = 'fixture-value-that-must-not-reach-errors';
    for (const override of [
      { RETAINER_EXTENSION_CATALOG: JSON.stringify({ secret: sensitive }) },
      { RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(privateJwk) },
      { RETAINER_EXTENSION_RUN_PUBLIC_KEY: sensitive },
    ]) {
      try {
        await extensionServices(loadConfig({ ...base, ...override }));
        throw new Error('configuration unexpectedly accepted');
      } catch (error) {
        expect(String(error)).toContain('invalid extension runtime configuration');
        expect(String(error)).not.toContain(sensitive);
        expect(String(error)).not.toContain(privateJwk.d);
      }
    }
    await expect(
      extensionServices(loadConfig({ ...base, RETAINER_EXTENSION_EXECUTABLES: '[]' }), {
        workerSql: t.sql,
      }),
    ).rejects.toThrow('configuration');
  });
  it('selects Lambda executor and verifier without launcher origins or bearer tokens and rejects cross-role catalog targets', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const prefix = 'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-';
    const verifierPrefix = prefix.replace('-ext-', '-extv-');
    const hosted = granolaManifest({
      version: '1.0.0',
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      verifierDigest: 'b'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    });
    const releases = [
      { manifest: hosted, actorCeiling: 'integration' as const, runtimeEnabled: true },
    ];
    const digest = new ExtensionCatalog(releases).list()[0]?.digest;
    const entries = hosted.functions.map((fn) => ({
      registrationId: hosted.universalId,
      releaseDigest: digest,
      functionId: fn.universalId,
      handlerDigest: fn.handlerDigest,
      packageDigest: hosted.packageDigest,
      runtimeVersion: 'node24',
      driverTarget: `${fn.trigger.kind === 'route' ? verifierPrefix : prefix}bundle:1`,
    }));
    const environment = {
      DATABASE_URL: db.url,
      RETAINER_EXTENSION_DRIVER: 'lambda',
      RETAINER_EXTENSION_LAMBDA_PREFIX: prefix,
      RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: verifierPrefix,
      RETAINER_PUBLIC_ORIGIN: 'https://retainer.test',
      RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(publicKey.export({ format: 'jwk' })),
      RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
      RETAINER_EXTENSION_SECRET_KEYS: JSON.stringify({
        currentVersion: 'test',
        keys: { test: randomBytes(32).toString('base64') },
      }),
      RETAINER_EXTENSION_CATALOG: JSON.stringify(releases),
      RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(entries),
    };
    const config = loadConfig(environment);
    const services = await extensionServices(config, {
      broker: true,
      workerSql: t.sql,
      ingressSql: t.sql,
    });
    try {
      expect(services.executor).toBeDefined();
      expect(services.webhooks).toBeDefined();
      expect(services.activationReady.has(digest as string)).toBe(true);
    } finally {
      await services.close();
    }
    const executorOnly = await extensionServices(
      loadConfig({
        ...environment,
        RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: undefined,
        RETAINER_EXTENSION_SECRET_KEYS: undefined,
      }),
      { workerSql: t.sql },
    );
    try {
      expect(executorOnly.executor).toBeDefined();
      expect(executorOnly.webhooks).toBeUndefined();
      expect(executorOnly.activationReady.has(digest as string)).toBe(true);
    } finally {
      await executorOnly.close();
    }
    const ingressOnly = await extensionServices(
      loadConfig({
        ...environment,
        RETAINER_EXTENSION_LAMBDA_PREFIX: undefined,
        RETAINER_EXTENSION_RUN_PRIVATE_KEY: undefined,
      }),
      { broker: true, ingressSql: t.sql },
    );
    try {
      expect(ingressOnly.executor).toBeUndefined();
      expect(ingressOnly.webhooks).toBeDefined();
      expect(ingressOnly.activationReady.has(digest as string)).toBe(true);
    } finally {
      await ingressOnly.close();
    }
    for (const [prefix, options] of [
      ['RETAINER_EXTENSION_LAMBDA_PREFIX', { workerSql: t.sql }],
      ['RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX', { broker: true, ingressSql: t.sql }],
    ] as const) {
      await expect(
        extensionServices(loadConfig({ ...environment, [prefix]: undefined }), options),
      ).rejects.toThrow('invalid extension runtime configuration');
    }
    for (const [prefixes, options] of [
      [{ RETAINER_EXTENSION_LAMBDA_PREFIX: undefined }, { broker: true, ingressSql: t.sql }],
      [{ RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: undefined }, { workerSql: t.sql }],
      [
        {
          RETAINER_EXTENSION_LAMBDA_PREFIX: undefined,
          RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: undefined,
        },
        {},
      ],
    ] as const) {
      for (const index of [0, entries.length - 1]) {
        for (const qualifier of ['', ':live']) {
          const invalid = entries.map((entry, i) =>
            i === index
              ? { ...entry, driverTarget: entry.driverTarget.replace(/:\d+$/, qualifier) }
              : entry,
          );
          await expect(
            extensionServices(
              loadConfig({
                ...environment,
                ...prefixes,
                RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(invalid),
              }),
              options,
            ),
          ).rejects.toThrow('invalid extension runtime configuration');
        }
      }
    }
    for (const index of [0, entries.length - 1]) {
      const wrong = entries.map((entry, i) =>
        i === index
          ? {
              ...entry,
              driverTarget: `${entry.driverTarget.startsWith(verifierPrefix) ? prefix : verifierPrefix}bundle:1`,
            }
          : entry,
      );
      await expect(
        extensionServices({ ...config, RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(wrong) }),
      ).rejects.toThrow('configuration');
    }
  });
});
