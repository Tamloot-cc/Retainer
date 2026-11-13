import { type ExtensionManifest, newestReleases } from '@retainer/extension';
import { hash } from './catalog.js';

/**
 * Automatic extension upgrades. An installed extension moves to the newest
 * release on its own only when that release differs from the installed one
 * in its code alone: the same access, settings, schema, views, mapping,
 * triggers and source. Anything else is held, and the extension's card offers
 * the upgrade for an admin to review.
 */

type Release = { manifest: ExtensionManifest; digest: string };
export type UpgradeTarget = { registrationId: string; version: string; digest: string };

/**
 * The newest release of each registration, when this process can run it. A
 * newest release that is not deployed yet is no target: older ones are never
 * chosen instead, so an installation does not move twice in one deploy.
 */
export function upgradeTargets(
  releases: readonly Release[],
  runnable: (release: Release) => boolean,
): UpgradeTarget[] {
  return [...newestReleases(releases).values()].filter(runnable).map((release) => ({
    registrationId: release.manifest.universalId,
    version: release.manifest.version,
    digest: release.digest,
  }));
}

/**
 * A manifest without what identifies its build: the version (it counts
 * commits on main) and the package and handler digests (they change with the
 * code). Two releases with the same contract differ in nothing an admin approves.
 */
export function releaseContract(manifest: ExtensionManifest): unknown {
  const { version: _version, packageDigest: _package, functions, ...rest } = manifest;
  return {
    ...rest,
    functions: functions.map(({ handlerDigest: _handler, ...fn }) => fn),
  };
}

/** Why an upgrade waits for an admin, or null when it can apply on its own. */
export type HoldReason =
  | 'previous_release_unavailable'
  | 'release_changes'
  | 'schema_changes'
  | 'view_changes'
  | 'mapping_changes';

export function holdReason(input: {
  /** The installed release's manifest, or undefined when the catalog no longer has it. */
  previous: ExtensionManifest | undefined;
  next: ExtensionManifest;
  schemaOperations: number;
  viewActions: readonly string[];
  storedMapping: unknown;
  plannedMapping: unknown;
}): HoldReason | null {
  // Without the installed manifest nothing can be compared; an admin decides.
  if (!input.previous) return 'previous_release_unavailable';
  if (hash(releaseContract(input.previous)) !== hash(releaseContract(input.next)))
    return 'release_changes';
  // The same contract can still plan work when the workspace drifted (a
  // deleted contributed field, an edited mapping target): an admin reviews it.
  if (input.schemaOperations > 0) return 'schema_changes';
  if (input.viewActions.some((action) => action === 'create' || action === 'update'))
    return 'view_changes';
  if (hash(input.storedMapping ?? null) !== hash(input.plannedMapping ?? null))
    return 'mapping_changes';
  return null;
}
