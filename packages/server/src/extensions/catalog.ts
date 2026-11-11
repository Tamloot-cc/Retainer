import { createHash } from 'node:crypto';
import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { AppError } from '../errors.js';
import { stableJson } from '../stable-json.js';
import { VERSION } from '../version.js';

export type ReviewedRelease = {
  manifest: ExtensionManifest;
  actorCeiling: 'integration' | 'agent';
  runtimeEnabled?: boolean;
};
export const hash = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex');

/** Constructed from release-bundled code only. Never populated from a workspace request. */
export class ExtensionCatalog {
  private readonly releases = new Map<string, ReviewedRelease & { digest: string }>();
  constructor(releases: readonly ReviewedRelease[] = []) {
    const actors = new Map<string, string>();
    for (const release of releases) {
      const manifest = defineExtension(release.manifest);
      if (release.actorCeiling !== manifest.requestedActor)
        throw new Error('registration does not permit requested actor');
      const priorActor = actors.get(manifest.universalId);
      if (priorActor && priorActor !== release.actorCeiling)
        throw new Error('registration actor ceiling cannot change across releases');
      actors.set(manifest.universalId, release.actorCeiling);
      const key = `${manifest.universalId}:${manifest.version}`;
      if (this.releases.has(key)) throw new Error('duplicate or mutable extension release');
      this.releases.set(key, structuredClone({ ...release, manifest, digest: hash(manifest) }));
    }
  }
  list() {
    return [...this.releases.values()]
      .filter((r) => r.manifest.serverVersions.includes(VERSION))
      .map((r) => structuredClone(r));
  }
  get(id: string, version: string) {
    const release = this.releases.get(`${id}:${version}`);
    if (!release) throw new AppError(404, 'not_found', 'extension release not found');
    if (!release.manifest.serverVersions.includes(VERSION))
      throw new AppError(
        409,
        'incompatible_runtime',
        'extension release does not support this server',
      );
    return structuredClone(release);
  }
}
