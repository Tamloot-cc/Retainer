import { ROUTINE_RUNNER_FUNCTION_ID, ROUTINE_RUNNER_REGISTRATION_ID } from '@retainer/shared';
import { z } from 'zod';
import type { Config } from '../config.js';
import { parseExtensionCatalog } from '../extensions/catalog.js';
import { type Executable, ExecutionRegistry } from '../worker/extensions.js';
import { LambdaDriver, type LambdaInvoke, LambdaVerifier } from '../worker/lambda-driver.js';

export type RuntimeCompatibility = { compatible: true } | { compatible: false; reason: string };
const incompatible = (reason: string): RuntimeCompatibility => ({ compatible: false, reason });
const short = (id: string) => id.slice(0, 12);

/**
 * Targets and expected identities come exclusively from packaged, operator-owned
 * registries. A failure names its first cause, so a stopped deploy can say why.
 */
export async function lambdaRuntimeCompatible(
  config: Config,
  invoke?: LambdaInvoke,
): Promise<RuntimeCompatibility> {
  if (!config.RETAINER_EXTENSION_EXECUTABLES) return incompatible('no executables are configured');
  const entries: unknown = JSON.parse(config.RETAINER_EXTENSION_EXECUTABLES);
  if (!Array.isArray(entries) || !entries.length)
    return incompatible('no executables are configured');
  const registry = new ExecutionRegistry(entries as Executable[]);
  const catalog = parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG);
  const targets = new Map<string, { digest: string; mode: 'job' | 'verify' }>();
  for (const entry of entries as Executable[]) {
    const executable = registry.lookup(entry.registrationId, entry.releaseDigest, entry.functionId);
    // The routine runner is not an extension: it has no catalog entry, and
    // runs as a job function (routines spec §11.3). Its health proves it.
    if (
      executable.registrationId === ROUTINE_RUNNER_REGISTRATION_ID &&
      executable.functionId === ROUTINE_RUNNER_FUNCTION_ID
    ) {
      const prior = targets.get(executable.driverTarget);
      if (prior && (prior.mode !== 'job' || prior.digest !== executable.releaseDigest))
        return incompatible(`target ${executable.driverTarget} serves two releases or modes`);
      targets.set(executable.driverTarget, { digest: executable.releaseDigest, mode: 'job' });
      continue;
    }
    const release = catalog.byDigest(executable.registrationId, executable.releaseDigest);
    const fn = release?.manifest.functions.find((f) => f.universalId === executable.functionId);
    const identity = `${short(executable.registrationId)} release ${short(executable.releaseDigest)} function ${short(executable.functionId)}`;
    if (!fn) return incompatible(`executable ${identity} has no function in the catalog`);
    if (release?.manifest.packageDigest !== executable.packageDigest)
      return incompatible(`executable ${identity} has a different package digest than the catalog`);
    if (fn.handlerDigest !== executable.handlerDigest)
      return incompatible(`executable ${identity} has a different handler digest than the catalog`);
    const mode = ['route', 'serverRoute'].includes(fn.trigger.kind) ? 'verify' : 'job';
    const prior = targets.get(executable.driverTarget);
    if (prior && (prior.mode !== mode || prior.digest !== executable.releaseDigest))
      return incompatible(`target ${executable.driverTarget} serves two releases or modes`);
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
    let response: unknown;
    try {
      response = await driver.health(target, AbortSignal.timeout(10000));
    } catch (error) {
      return incompatible(`target ${target} health check failed: ${message(error)}`);
    }
    const health = z
      .strictObject({
        protocolVersion: z.literal(1),
        runtimeVersion: z.literal('node24'),
        releaseDigest: z.literal(expected.digest),
        mode: z.literal(expected.mode),
      })
      .safeParse(response);
    if (!health.success)
      return incompatible(
        `target ${target} does not report release ${short(expected.digest)} in ${expected.mode} mode: ${health.error.issues.map((issue) => `${issue.path.join('.') || 'response'} ${issue.message}`).join('; ')}`,
      );
  }
  return { compatible: true };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
