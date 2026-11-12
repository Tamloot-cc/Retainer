import { z } from 'zod';
import type { Config } from '../config.js';
import { parseExtensionCatalog } from '../extensions/catalog.js';
import { type Executable, ExecutionRegistry } from '../worker/extensions.js';
import { LambdaDriver, type LambdaInvoke, LambdaVerifier } from '../worker/lambda-driver.js';

/** Targets and expected identities come exclusively from packaged, operator-owned registries. */
export async function lambdaRuntimeCompatible(config: Config, invoke?: LambdaInvoke) {
  if (!config.RETAINER_EXTENSION_EXECUTABLES) return false;
  const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
  if (!Array.isArray(entries) || !entries.length) return false;
  const registry = new ExecutionRegistry(entries as Executable[]);
  const catalog = parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG);
  const targets = new Map<string, { digest: string; mode: 'job' | 'verify' }>();
  for (const entry of entries as Executable[]) {
    const executable = registry.lookup(entry.registrationId, entry.releaseDigest, entry.functionId);
    const release = catalog
      .list()
      .find(
        (r) =>
          r.digest === executable.releaseDigest &&
          r.manifest.universalId === executable.registrationId,
      );
    const fn = release?.manifest.functions.find((f) => f.universalId === executable.functionId);
    if (
      !fn ||
      release?.manifest.packageDigest !== executable.packageDigest ||
      fn.handlerDigest !== executable.handlerDigest
    )
      return false;
    const mode = ['route', 'serverRoute'].includes(fn.trigger.kind) ? 'verify' : 'job';
    const prior = targets.get(executable.driverTarget);
    if (prior && (prior.mode !== mode || prior.digest !== executable.releaseDigest)) return false;
    targets.set(executable.driverTarget, { digest: executable.releaseDigest, mode });
  }
  // Sequential bounded probes avoid an unbounded fan-out against retained releases.
  for (const [target, expected] of targets) {
    const prefix =
      expected.mode === 'job'
        ? config.RETAINER_EXTENSION_LAMBDA_PREFIX
        : config.RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX;
    const driver =
      expected.mode === 'job'
        ? new LambdaDriver(prefix, invoke)
        : new LambdaVerifier(prefix, invoke);
    const response = await driver.health(target, AbortSignal.timeout(10000));
    if (
      !z
        .strictObject({
          protocolVersion: z.literal(1),
          runtimeVersion: z.literal('node24'),
          releaseDigest: z.literal(expected.digest),
          mode: z.literal(expected.mode),
        })
        .safeParse(response).success
    )
      return false;
  }
  return true;
}
