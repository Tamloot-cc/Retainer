import { importJWK } from 'jose';
import { z } from 'zod';
import { type Config, EXECUTOR_ROLE, ownerDatabaseUrl, SECRET_BROKER_ROLE } from '../config.js';
import { createSql, type Sql } from '../db/client.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../extension-runtime/secrets.js';
import { RunTokens } from '../extension-runtime/tokens.js';
import { ExtensionCatalog } from '../extensions/catalog.js';
import { createFileStorage } from '../file-storage/configuration.js';
import { Webhooks } from '../webhooks/service.js';
import { ChangeMaintenance } from '../worker/changes.js';
import { type Executable, ExecutionRegistry, ExtensionExecutor } from '../worker/extensions.js';
import { FileMaintenance } from '../worker/files.js';
import { LauncherDriver } from '../worker/launch-driver.js';
import { LauncherVerifier } from '../worker/verifier-driver.js';

/** These are operator-provisioned release inputs. Workspace APIs cannot change them. */
export async function extensionServices(
  config: Config,
  options: { broker?: boolean; workerSql?: Sql; ingressSql?: Sql } = {},
) {
  const owned: Sql[] = [];
  const close = () => Promise.all(owned.map((pool) => pool.end({ timeout: 5 }))).then(() => {});
  try {
    const entries = config.RETAINER_EXTENSION_CATALOG
      ? JSON.parse(config.RETAINER_EXTENSION_CATALOG)
      : [];
    const releases = z
      .array(
        z.strictObject({
          manifest: z.unknown(),
          actorCeiling: z.enum(['integration', 'agent']),
          runtimeEnabled: z.boolean().optional(),
        }),
      )
      .parse(entries);
    // Catalog validates and copies each JSON manifest rather than evaluating package code.
    const { defineExtension } = await import('@retainer/extension');
    const catalog = new ExtensionCatalog(
      releases.map((release) => ({ ...release, manifest: defineExtension(release.manifest) })),
    );
    const jwk = z.strictObject({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      x: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
      alg: z.literal('EdDSA').optional(),
      use: z.literal('sig').optional(),
      kid: z.string().optional(),
    });
    let tokens: RunTokens | undefined;
    if (config.RETAINER_EXTENSION_RUN_PUBLIC_KEY) {
      const publicJwk = jwk.parse(JSON.parse(config.RETAINER_EXTENSION_RUN_PUBLIC_KEY));
      const verificationKey = await importJWK(publicJwk, 'EdDSA');
      if (verificationKey instanceof Uint8Array) throw new Error('asymmetric run keys required');
      let signingKey: CryptoKey | undefined;
      if (options.workerSql && config.RETAINER_EXTENSION_RUN_PRIVATE_KEY) {
        const privateJwk = jwk
          .extend({ d: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) })
          .parse(JSON.parse(config.RETAINER_EXTENSION_RUN_PRIVATE_KEY));
        if (privateJwk.x !== publicJwk.x) throw new Error('run key pair differs');
        const imported = await importJWK(privateJwk, 'EdDSA');
        if (imported instanceof Uint8Array) throw new Error('asymmetric run key required');
        const challenge = new TextEncoder().encode('retainer extension signing key preflight');
        const signature = await crypto.subtle.sign('Ed25519', imported, challenge);
        if (!(await crypto.subtle.verify('Ed25519', verificationKey, signature, challenge)))
          throw new Error('run key pair does not verify');
        signingKey = imported;
      }
      const issuer = config.RETAINER_EXTENSION_ISSUER ?? config.RETAINER_PUBLIC_ORIGIN;
      if (!issuer) throw new Error('extension issuer is required');
      tokens = new RunTokens({
        issuer,
        keyId: config.RETAINER_EXTENSION_RUN_KEY_ID,
        verificationKey,
        ...(signingKey ? { signingKey } : {}),
      });
    }
    let broker: SecretBroker | undefined;
    if (options.broker && config.RETAINER_EXTENSION_SECRET_KEYS) {
      const keyring = z
        .strictObject({
          currentVersion: z.string().min(1).max(100),
          keys: z.record(z.string(), z.string()),
        })
        .parse(JSON.parse(config.RETAINER_EXTENSION_SECRET_KEYS));
      const url = config.RETAINER_SECRET_BROKER_DATABASE_URL;
      const pool = url
        ? createSql(url, { max: 2 })
        : createSql(ownerDatabaseUrl(config), { role: SECRET_BROKER_ROLE, max: 2 });
      owned.push(pool);
      broker = new SecretBroker(
        pool,
        new SecretCipher(
          keyring.currentVersion,
          new Map(
            Object.entries(keyring.keys).map(([version, key]) => [
              version,
              Buffer.from(key, 'base64'),
            ]),
          ),
        ),
      );
    }
    const fileStorage = await createFileStorage(config);
    if (config.RETAINER_ROLE === 'files' && !fileStorage)
      throw new Error('file maintenance requires storage configuration');
    const discovery = options.workerSql
      ? config.RETAINER_EXECUTOR_DATABASE_URL
        ? createSql(config.RETAINER_EXECUTOR_DATABASE_URL, { max: 1 })
        : createSql(ownerDatabaseUrl(config), { role: EXECUTOR_ROLE, max: 1 })
      : undefined;
    if (discovery) owned.push(discovery);
    const fileMaintenance =
      fileStorage && options.workerSql && discovery
        ? new FileMaintenance(options.workerSql, discovery, fileStorage)
        : undefined;
    const changeQueue =
      catalog
        .list()
        .some((release) => release.manifest.functions.some((fn) => fn.trigger.kind === 'change')) &&
      options.workerSql
        ? new ExtensionQueue(options.workerSql, (id, version, digest) => {
            const release = catalog.get(id, version);
            if (release.digest !== digest) throw new Error('registered release differs');
            return release.manifest;
          })
        : undefined;
    const changeMaintenance =
      options.workerSql && discovery
        ? new ChangeMaintenance(options.workerSql, discovery, changeQueue)
        : undefined;
    const activationReady = new Set<string>();
    if (tokens && config.RETAINER_EXTENSION_EXECUTABLES) {
      const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
      if (!Array.isArray(entries)) throw new Error('invalid executable registry');
      const registry = new ExecutionRegistry(entries as Executable[]);
      for (const release of catalog.list()) {
        if (!release.runtimeEnabled || release.manifest.execution !== 'hosted') continue;
        for (const fn of release.manifest.functions) {
          if (['route', 'serverRoute'].includes(fn.trigger.kind)) {
            if (
              !config.RETAINER_EXTENSION_VERIFIER_ORIGIN ||
              !release.manifest.webhooks?.some((hook) => hook.verifierFunctionId === fn.universalId)
            )
              throw new Error('verifier runtime is unavailable');
          } else if (
            !['job', 'install', 'uninstall', 'schedule', 'change'].includes(fn.trigger.kind)
          )
            throw new Error('trigger runtime is unavailable');
          const executable = registry.lookup(
            release.manifest.universalId,
            release.digest,
            fn.universalId,
          );
          if (
            executable.handlerDigest !== fn.handlerDigest ||
            executable.packageDigest !== release.manifest.packageDigest
          )
            throw new Error('release executable differs from catalog');
        }
        activationReady.add(release.digest);
      }
    }
    let webhooks: Webhooks | undefined;
    if (options.ingressSql && config.RETAINER_EXTENSION_VERIFIER_ORIGIN) {
      if (
        !broker ||
        !config.RETAINER_VERIFIER_TOKEN ||
        !config.RETAINER_PUBLIC_ORIGIN ||
        !config.RETAINER_EXTENSION_EXECUTABLES
      )
        throw new Error('webhook ingress configuration is incomplete');
      if (config.RETAINER_VERIFIER_TOKEN === config.RETAINER_LAUNCHER_TOKEN)
        throw new Error('verifier and executor credentials must differ');
      const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
      if (!Array.isArray(entries)) throw new Error('invalid verifier registry');
      webhooks = new Webhooks({
        sql: options.ingressSql,
        catalog,
        broker,
        registry: new ExecutionRegistry(entries as Executable[]),
        driver: new LauncherVerifier(
          config.RETAINER_EXTENSION_VERIFIER_ORIGIN,
          config.RETAINER_VERIFIER_TOKEN,
        ),
        publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
        rateLimit: config.RETAINER_WEBHOOK_RATE_LIMIT,
      });
    }
    let executor: ExtensionExecutor | undefined;
    if (options.workerSql && config.RETAINER_EXTENSION_EXECUTABLES) {
      if (
        !tokens ||
        !config.RETAINER_EXTENSION_RUN_PRIVATE_KEY ||
        !config.RETAINER_EXTENSION_LAUNCHER_ORIGIN ||
        !config.RETAINER_LAUNCHER_TOKEN
      )
        throw new Error('executor configuration is incomplete');
      const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
      if (!Array.isArray(entries)) throw new Error('executor registry must be an array');
      // ExecutionRegistry performs strict per-entry validation and defensive copies.
      const registry = new ExecutionRegistry(entries as Executable[]);
      const discoverySql = discovery as Sql;
      const apiOrigin = config.RETAINER_EXTENSION_API_ORIGIN ?? config.RETAINER_PUBLIC_ORIGIN;
      if (!apiOrigin) throw new Error('executor API origin is required');
      executor = new ExtensionExecutor({
        sql: options.workerSql,
        discoverySql,
        catalog,
        registry,
        tokens,
        driver: new LauncherDriver(
          config.RETAINER_EXTENSION_LAUNCHER_ORIGIN,
          config.RETAINER_LAUNCHER_TOKEN,
        ),
        apiOrigin,
        owner: `executor-${crypto.randomUUID()}`,
      });
    }
    return {
      catalog,
      tokens,
      broker,
      webhooks,
      executor,
      activationReady,
      fileStorage,
      fileMaintenance,
      changeMaintenance,
      close,
    };
  } catch {
    await close();
    // Never include raw configuration, key material, connection URLs or parse errors.
    throw new Error(
      'invalid extension runtime configuration; check catalog, keyring, run keys, executor and file storage settings',
    );
  }
}
