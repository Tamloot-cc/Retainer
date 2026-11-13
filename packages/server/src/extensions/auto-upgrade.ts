import type { ExtensionManifest } from '@retainer/extension';
import { hash } from './catalog.js';

/**
 * Automatic extension upgrades. An installed extension moves to the newest
 * release on its own only when the upgrade needs nothing an admin approves:
 * no schema or view changes, no mapping change, no new access, no new
 * settings and no change to its source. Anything else is held, and the
 * extension's card offers the upgrade for review.
 */

/** Compares manifest versions (`x.y.z`, enforced by the manifest schema) numerically. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export type UpgradeTarget = { registrationId: string; version: string; digest: string };

/**
 * The newest release of each registration, when this process can run it. A
 * newest release that is not deployed yet is no target: older ones are never
 * chosen instead, so an installation does not move twice in one deploy.
 */
export function upgradeTargets(
  releases: readonly { manifest: ExtensionManifest; digest: string }[],
  runnable: (release: { manifest: ExtensionManifest; digest: string }) => boolean,
): UpgradeTarget[] {
  const newest = new Map<string, { manifest: ExtensionManifest; digest: string }>();
  for (const release of releases) {
    const prior = newest.get(release.manifest.universalId);
    if (!prior || compareVersions(release.manifest.version, prior.manifest.version) > 0)
      newest.set(release.manifest.universalId, release);
  }
  return [...newest.values()].filter(runnable).map((release) => ({
    registrationId: release.manifest.universalId,
    version: release.manifest.version,
    digest: release.digest,
  }));
}

/** Why an upgrade waits for an admin, or null when it can apply on its own. */
export type HoldReason =
  | 'schema_changes'
  | 'view_changes'
  | 'mapping_changes'
  | 'access_changes'
  | 'new_settings'
  | 'source_changes'
  | 'previous_release_unavailable';

export function holdReason(input: {
  /** The installed release's manifest, or undefined when the catalog no longer has it. */
  previous: ExtensionManifest | undefined;
  next: ExtensionManifest;
  grantedActor: string;
  grantedScopes: readonly string[];
  schemaOperations: number;
  viewActions: readonly string[];
  storedMapping: unknown;
  plannedMapping: unknown;
}): HoldReason | null {
  const { previous, next } = input;
  // Without the installed manifest nothing can be compared; an admin decides.
  if (!previous) return 'previous_release_unavailable';
  if (input.schemaOperations > 0) return 'schema_changes';
  if (input.viewActions.some((action) => action === 'create' || action === 'update'))
    return 'view_changes';
  if (hash(input.storedMapping ?? null) !== hash(input.plannedMapping ?? null))
    return 'mapping_changes';
  if (
    next.requestedActor !== input.grantedActor ||
    next.scopes.length !== input.grantedScopes.length ||
    next.scopes.some((scope) => !input.grantedScopes.includes(scope)) ||
    next.execution !== previous.execution ||
    next.connection !== previous.connection ||
    next.oauthClientId !== previous.oauthClientId
  )
    return 'access_changes';
  // A new setting or secret is a choice the admin has not made yet.
  if (Object.keys(next.settings).some((key) => !Object.hasOwn(previous.settings, key)))
    return 'new_settings';
  if (hash(next.source ?? null) !== hash(previous.source ?? null)) return 'source_changes';
  return null;
}
