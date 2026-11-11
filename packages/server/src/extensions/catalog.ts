import { createHash } from 'node:crypto';
import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
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
  readonly runtime: RuntimeCatalog;
  private readonly releases = new Map<string, ReviewedRelease & { digest: string }>();
  constructor(releases: readonly ReviewedRelease[] = []) {
    const actors = new Map<string, string>();
    const locators = new Map<string, string>();
    const clients = new Map<string, string>();
    for (const release of releases) {
      const manifest = defineExtension(release.manifest);
      if (release.actorCeiling === 'agent' && manifest.requestedActor === 'integration')
        throw new Error('registration does not permit requested actor');
      for (const hook of manifest.webhooks ?? []) {
        const key = `${manifest.universalId}:${hook.route}`,
          locator = hook.accountHeader ?? '';
        if (locators.has(key) && locators.get(key) !== locator)
          throw new Error(
            'registration webhook locator cannot change across releases; use a new route',
          );
        locators.set(key, locator);
      }
      if (manifest.oauthClientId) {
        const prior = clients.get(manifest.universalId);
        if (prior && prior !== manifest.oauthClientId)
          throw new Error('registration OAuth client cannot change across releases');
        clients.set(manifest.universalId, manifest.oauthClientId);
      }
      const priorActor = actors.get(manifest.universalId);
      if (priorActor && priorActor !== release.actorCeiling)
        throw new Error('registration actor ceiling cannot change across releases');
      actors.set(manifest.universalId, release.actorCeiling);
      const key = `${manifest.universalId}:${manifest.version}`;
      if (this.releases.has(key)) throw new Error('duplicate or mutable extension release');
      this.releases.set(key, structuredClone({ ...release, manifest, digest: hash(manifest) }));
    }
    this.runtime = Object.freeze({
      identity: hash({
        serverVersion: VERSION,
        runtimeVersion: 'node24',
        protocolVersion: 1,
        releases: [...this.releases.values()].sort((a, b) => a.digest.localeCompare(b.digest)),
      }),
      resolve: (id: string, version: string) => {
        const release = this.get(id, version);
        if (release.manifest.execution === 'hosted' && release.runtimeEnabled !== true)
          throw new AppError(
            409,
            'incompatible_runtime',
            'hosted execution is disabled in this catalog',
          );
        return release.manifest;
      },
    });
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

/** Operator-owned catalog data, shared by API and consent control without evaluating package code. */
export function parseExtensionCatalog(raw?: string): ExtensionCatalog {
  const entries = z
    .array(
      z.strictObject({
        manifest: z.unknown(),
        actorCeiling: z.enum(['integration', 'agent']),
        runtimeEnabled: z.boolean().optional(),
      }),
    )
    .parse(raw ? JSON.parse(raw) : []);
  return new ExtensionCatalog(
    entries.map((entry) => ({ ...entry, manifest: defineExtension(entry.manifest) })),
  );
}
