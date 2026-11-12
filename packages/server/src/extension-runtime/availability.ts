import { createHash } from 'node:crypto';
import type { ExtensionManifest } from '@retainer/extension';
import { AppError } from '../errors.js';
import { stableJson } from '../stable-json.js';

export type ReleasePin = {
  id: string;
  workspace_id: string;
  registration_id: string;
  version: string;
  generation: number;
  release_digest: string;
};
type Pin = Pick<ReleasePin, 'registration_id' | 'version' | 'release_digest'>;
/** Immutable local catalog: every reviewed release it holds, runnable here or not. */
export type RuntimeCatalog = {
  readonly releases: readonly Pin[];
  readonly resolve: (registration: string, version: string) => ExtensionManifest;
};
export type ReleaseResolution =
  | { available: true; manifest: ExtensionManifest }
  | { available: false; code: 'incompatible_runtime' | 'release_unavailable' };

export function resolveRelease(catalog: RuntimeCatalog, pin: Pin): ReleaseResolution {
  try {
    const manifest = catalog.resolve(pin.registration_id, pin.version);
    if (
      manifest.universalId !== pin.registration_id ||
      manifest.version !== pin.version ||
      createHash('sha256').update(stableJson(manifest)).digest('hex') !== pin.release_digest
    )
      return { available: false, code: 'incompatible_runtime' };
    return { available: true, manifest };
  } catch (error) {
    return {
      available: false,
      code:
        error instanceof AppError && error.code === 'incompatible_runtime'
          ? 'incompatible_runtime'
          : 'release_unavailable',
    };
  }
}

export function requireRelease(catalog: RuntimeCatalog, pin: Pin) {
  const result = resolveRelease(catalog, pin);
  if (!result.available)
    throw new AppError(409, result.code, 'pinned extension release is unavailable in this runtime');
  return result.manifest;
}

/**
 * Whether this process can run the pin: it resolves and, when the process
 * knows its deployed executables (`activation`), a hosted release has one.
 * Without `activation` the answer is the catalog's alone.
 */
export function releaseAvailability(
  catalog: RuntimeCatalog,
  pin: Pin,
  activation?: ReadonlySet<string>,
): ReleaseResolution {
  const result = resolveRelease(catalog, pin);
  if (
    result.available &&
    result.manifest.execution === 'hosted' &&
    activation &&
    !activation.has(pin.release_digest)
  )
    return { available: false, code: 'incompatible_runtime' };
  return result;
}

/**
 * The (registration, release digest) pairs this process can run now: they
 * resolve in its catalog (server range, `runtimeEnabled`) and, when it knows
 * its deployed executables (`activation`), a hosted release has one. Parallel
 * arrays, passed to the `*_due` discovery functions; work pinned to any other
 * release stays queued, untouched, for a worker that can run it.
 */
export function runnableReleases(catalog: RuntimeCatalog, activation?: ReadonlySet<string>) {
  const registrations: string[] = [],
    digests: string[] = [];
  for (const pin of catalog.releases) {
    if (!releaseAvailability(catalog, pin, activation).available) continue;
    registrations.push(pin.registration_id);
    digests.push(pin.release_digest);
  }
  return { registrations, digests };
}
