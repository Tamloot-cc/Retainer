import { createHash } from 'node:crypto';
import type { ExtensionManifest } from '@retainer/extension';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { stableJson } from '../stable-json.js';

export type ReleasePin = {
  id: string;
  workspace_id: string;
  registration_id: string;
  version: string;
  generation: number;
  release_digest: string;
};
/** Immutable local catalog; identity includes server compatibility and all reviewed releases. */
export type RuntimeCatalog = {
  readonly identity: string;
  readonly resolve: (registration: string, version: string) => ExtensionManifest;
};
export type ReleaseResolution =
  | { available: true; manifest: ExtensionManifest }
  | { available: false; code: 'incompatible_runtime' | 'release_unavailable' };

export function resolveRelease(
  catalog: RuntimeCatalog,
  pin: Pick<ReleasePin, 'registration_id' | 'version' | 'release_digest'>,
): ReleaseResolution {
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
    // Local reviewed metadata only: never persist exception text or provider/customer content.
    return {
      available: false,
      code:
        error instanceof AppError && error.code === 'incompatible_runtime'
          ? 'incompatible_runtime'
          : 'release_unavailable',
    };
  }
}

/** A failure is evidence about this catalog and pin, never a global installation disable. */
export class RuntimeAvailability {
  constructor(readonly catalog: RuntimeCatalog) {
    if (!/^[a-f0-9]{64}$/.test(catalog.identity))
      throw new Error('runtime catalog identity must be SHA-256');
  }
  require(pin: Pick<ReleasePin, 'registration_id' | 'version' | 'release_digest'>) {
    const result = resolveRelease(this.catalog, pin);
    if (!result.available)
      throw new AppError(
        409,
        result.code,
        'pinned extension release is unavailable in this runtime',
      );
    return result.manifest;
  }
  /** Caller holds schema, installation and queue locks, with a freshly read generation. */
  async inspect(
    tx: Tx,
    pin: ReleasePin,
    options: { knownFailureOnly?: boolean } = {},
  ): Promise<ExtensionManifest | null> {
    const [marker] = await tx<
      { waiting: boolean }[]
    >`select retry_at>clock_timestamp() as waiting from extension_runtime_unavailable where installation_id=${pin.id}
      and runtime_identity=${this.catalog.identity} and generation=${pin.generation} and release_digest=${pin.release_digest}`;
    if (marker?.waiting || (options.knownFailureOnly && !marker)) return null;
    const result = resolveRelease(this.catalog, pin);
    if (result.available) {
      await tx`delete from extension_runtime_unavailable where installation_id=${pin.id} and runtime_identity=${this.catalog.identity}`;
      return result.manifest;
    }
    await tx`insert into extension_runtime_unavailable(workspace_id,installation_id,runtime_identity,generation,release_digest,code,retry_at,checked_at)
      values(${pin.workspace_id},${pin.id},${this.catalog.identity},${pin.generation},${pin.release_digest},${result.code},clock_timestamp()+interval '5 minutes',clock_timestamp())
      on conflict(workspace_id,installation_id,runtime_identity) do update set generation=excluded.generation,
        release_digest=excluded.release_digest,code=excluded.code,retry_at=excluded.retry_at,checked_at=excluded.checked_at`;
    log.warn('Extension runtime unavailable', {
      installationId: pin.id,
      generation: pin.generation,
      releaseDigest: pin.release_digest,
      runtimeIdentity: this.catalog.identity,
      code: result.code,
    });
    return null;
  }
}
