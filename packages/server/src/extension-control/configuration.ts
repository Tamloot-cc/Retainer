import { importJWK } from 'jose';
import { z } from 'zod';
import { type Config, EXECUTOR_ROLE, ownerDatabaseUrl, SECRET_BROKER_ROLE } from '../config.js';
import { createSql, type Sql } from '../db/client.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../extension-runtime/secrets.js';
import { RunTokens } from '../extension-runtime/tokens.js';
import { parseExtensionCatalog } from '../extensions/catalog.js';
import { Extensions } from '../extensions/service.js';
import { createFileStorage } from '../file-storage/configuration.js';
import { Webhooks } from '../webhooks/service.js';
import { ChangeMaintenance } from '../worker/changes.js';
import { type Executable, ExecutionRegistry, ExtensionExecutor } from '../worker/extensions.js';
import { FileMaintenance } from '../worker/files.js';
import {
  assertLambdaTarget,
  assertLambdaVersionTarget,
  LambdaDriver,
  LambdaVerifier,
} from '../worker/lambda-driver.js';
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
    const lambda = config.RETAINER_EXTENSION_DRIVER === 'lambda';
    const verifierConfigured = lambda
      ? config.RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX
      : config.RETAINER_EXTENSION_VERIFIER_ORIGIN;
    const catalog = parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG);
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
              (!lambda && !verifierConfigured) ||
              !release.manifest.webhooks?.some((hook) => hook.verifierFunctionId === fn.universalId)
            )
              throw new Error('verifier runtime is unavailable');
          } else if (
            !['job', 'configure', 'install', 'uninstall', 'schedule', 'change'].includes(
              fn.trigger.kind,
            )
          )
            throw new Error('trigger runtime is unavailable');
          const executable = registry.lookup(
            release.manifest.universalId,
            release.digest,
            fn.universalId,
          );
          const prefix = ['route', 'serverRoute'].includes(fn.trigger.kind)
            ? config.RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX
            : config.RETAINER_EXTENSION_LAMBDA_PREFIX;
          // All roles validate immutable ARN shape. Namespace checks additionally
          // use this process's own prefix, without requiring the other role's prefix.
          if (lambda) {
            assertLambdaVersionTarget(executable.driverTarget);
            if (prefix) assertLambdaTarget(executable.driverTarget, prefix);
          }
          if (
            executable.handlerDigest !== fn.handlerDigest ||
            executable.packageDigest !== release.manifest.packageDigest
          )
            throw new Error('release executable differs from catalog');
        }
        activationReady.add(release.digest);
      }
    }
    // Known only where this process loads the executable registry; elsewhere
    // availability is the catalog's alone (docs/extensions-execution.md).
    const activation =
      tokens && config.RETAINER_EXTENSION_EXECUTABLES ? activationReady : undefined;
    const changeQueue =
      catalog
        .list()
        .some((release) => release.manifest.functions.some((fn) => fn.trigger.kind === 'change')) &&
      options.workerSql
        ? new ExtensionQueue(
            options.workerSql,
            catalog.runtime,
            {
              queued: 10000,
              kvBytes: 1048576,
              changesPerMinute: config.RETAINER_TRIGGER_ENQUEUES_PER_MINUTE,
            },
            activation,
          )
        : undefined;
    let webhooks: Webhooks | undefined;
    if (options.ingressSql && (lambda || verifierConfigured)) {
      if (
        !broker ||
        (!lambda && !config.RETAINER_VERIFIER_TOKEN) ||
        !config.RETAINER_PUBLIC_ORIGIN ||
        !config.RETAINER_EXTENSION_EXECUTABLES
      )
        throw new Error('webhook ingress configuration is incomplete');
      if (!lambda && config.RETAINER_VERIFIER_TOKEN === config.RETAINER_LAUNCHER_TOKEN)
        throw new Error('verifier and executor credentials must differ');
      const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
      if (!Array.isArray(entries)) throw new Error('invalid verifier registry');
      webhooks = new Webhooks({
        sql: options.ingressSql,
        catalog,
        broker,
        registry: new ExecutionRegistry(entries as Executable[]),
        driver: lambda
          ? new LambdaVerifier(config.RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX)
          : new LauncherVerifier(
              config.RETAINER_EXTENSION_VERIFIER_ORIGIN as string,
              config.RETAINER_VERIFIER_TOKEN as string,
            ),
        publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
        rateLimit: config.RETAINER_WEBHOOK_RATE_LIMIT,
        activation,
      });
    }
    let executor: ExtensionExecutor | undefined;
    if (options.workerSql && config.RETAINER_EXTENSION_EXECUTABLES) {
      if (
        !tokens ||
        !config.RETAINER_EXTENSION_RUN_PRIVATE_KEY ||
        (!lambda && (!config.RETAINER_EXTENSION_LAUNCHER_ORIGIN || !config.RETAINER_LAUNCHER_TOKEN))
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
        driver: lambda
          ? new LambdaDriver(config.RETAINER_EXTENSION_LAMBDA_PREFIX)
          : new LauncherDriver(
              config.RETAINER_EXTENSION_LAUNCHER_ORIGIN as string,
              config.RETAINER_LAUNCHER_TOKEN as string,
            ),
        ...(lambda ? { concurrency: config.RETAINER_EXECUTOR_CONCURRENCY } : {}),
        apiOrigin,
        owner: `executor-${crypto.randomUUID()}`,
        activation: activationReady,
        // Automatic upgrades run where the deployed releases are known.
        upgrades: new Extensions(options.workerSql, catalog, broker, activationReady),
      });
    }
    // Without an executor (standalone apps only), change maintenance runs the
    // automatic upgrades the executor would.
    const changeMaintenance =
      options.workerSql && discovery
        ? new ChangeMaintenance(
            options.workerSql,
            discovery,
            changeQueue,
            executor ? undefined : new Extensions(options.workerSql, catalog, broker, activation),
          )
        : undefined;
    return {
      catalog,
      tokens,
      broker,
      webhooks,
      executor,
      activationReady,
      activation,
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
