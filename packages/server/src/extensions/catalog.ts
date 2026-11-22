import { createHash } from 'node:crypto';
import {
  defineExtension,
  type ExtensionManifest,
  runsHostedCode,
  supportsServer,
} from '@retainer/extension';
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
  /** The same releases by digest, which identifies a release across registrations. */
  private readonly digests = new Map<string, ReviewedRelease & { digest: string }>();
  constructor(releases: readonly ReviewedRelease[] = []) {
    const actors = new Map<string, string>();
    const connections = new Map<string, string>();
    const locators = new Map<string, string>();
    const clients = new Map<string, string>(),
      clientOwners = new Map<string, string>();
    for (const release of releases) {
      const manifest = defineExtension(release.manifest);
      const connection = connections.get(manifest.universalId);
      if (connection && connection !== manifest.connection)
        throw new Error('registration connection mode cannot change across releases');
      connections.set(manifest.universalId, manifest.connection);
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
        // One registration per client: a workspace has one installation per
        // registration, so a client names at most one installation in it,
        // which app sign-in's token exchange relies on (extensions spec 8).
        const owner = clientOwners.get(manifest.oauthClientId);
        if (owner && owner !== manifest.universalId)
          throw new Error('an OAuth client belongs to one registration');
        clients.set(manifest.universalId, manifest.oauthClientId);
        clientOwners.set(manifest.oauthClientId, manifest.universalId);
      }
      const priorActor = actors.get(manifest.universalId);
      if (priorActor && priorActor !== release.actorCeiling)
        throw new Error('registration actor ceiling cannot change across releases');
      actors.set(manifest.universalId, release.actorCeiling);
      const key = `${manifest.universalId}:${manifest.version}`;
      if (this.releases.has(key)) throw new Error('duplicate or mutable extension release');
      const entry = structuredClone({ ...release, manifest, digest: hash(manifest) });
      this.releases.set(key, entry);
      this.digests.set(entry.digest, entry);
    }
    this.runtime = Object.freeze({
      releases: Object.freeze(
        [...this.releases.values()].map((r) => ({
          registration_id: r.manifest.universalId,
          version: r.manifest.version,
          release_digest: r.digest,
        })),
      ),
      resolve: (id: string, version: string) => {
        const release = this.get(id, version);
        if (runsHostedCode(release.manifest) && release.runtimeEnabled !== true)
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
      .filter((r) => supportsServer(r.manifest, VERSION))
      .map((r) => structuredClone(r));
  }
  /** The release if this catalog still holds it, for reads that must survive its removal. */
  find(id: string, version: string) {
    return this.releases.get(`${id}:${version}`);
  }
  /** The registration's release with this digest, if this process can run it. */
  byDigest(registrationId: string, digest: string) {
    const release = this.digests.get(digest);
    if (
      release?.manifest.universalId !== registrationId ||
      !supportsServer(release.manifest, VERSION)
    )
      return undefined;
    return structuredClone(release);
  }
  /**
   * The release a live run was started on, or `503 release_not_loaded` when this
   * process lacks it: a deploy has not reached it yet (docs/extensions-execution.md,
   * "Unavailable releases and server upgrades").
   */
  forRun(run: { registrationId: string; releaseDigest: string }) {
    const release = this.byDigest(run.registrationId, run.releaseDigest);
    if (!release)
      throw new AppError(
        503,
        'release_not_loaded',
        "this server does not have the run's extension release yet; retry shortly",
      );
    return release;
  }
  get(id: string, version: string) {
    const release = this.releases.get(`${id}:${version}`);
    if (!release) throw new AppError(404, 'not_found', 'extension release not found');
    if (!supportsServer(release.manifest, VERSION))
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
    entries.flatMap((entry) => {
      // Published snapshots can retain releases retired by the binding migration.
      const manifest = entry.manifest;
      if (manifest && typeof manifest === 'object') {
        if ('mapping' in manifest) return [];
        if (
          'source' in manifest &&
          manifest.source &&
          typeof manifest.source === 'object' &&
          'eventTypeIds' in manifest.source
        )
          return [];
        if (
          'lastContact' in manifest &&
          manifest.lastContact &&
          typeof manifest.lastContact === 'object' &&
          'fields' in manifest.lastContact
        )
          return [];
      }
      return [{ ...entry, manifest: defineExtension(manifest) }];
    }),
  );
}
