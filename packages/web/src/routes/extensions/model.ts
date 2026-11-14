import { compareVersions, MODEL_USE_NOTICE, newestReleases } from '@retainer/extension';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import type { Tone } from '../../ui/index.js';

export type Release = Awaited<ReturnType<typeof api.extensionCatalog>>['releases'][number];
export type Installation = Awaited<ReturnType<typeof api.extensions>>['installations'][number];

export const queryKey = ['extensions'];
export const stateLabel = (state: string) =>
  state.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

const BUSY = ['installing', 'upgrading', 'uninstalling'];
const GONE = ['uninstalled', 'uninstalling'];
export const isGone = (installation: Installation) => GONE.includes(installation.state);

/** The catalog and the installations, polled while one is changing state. */
export function useExtensions() {
  const catalog = useQuery({
    queryKey: [...queryKey, 'catalog'],
    queryFn: ({ signal }) => api.extensionCatalog(signal),
  });
  const installations = useQuery({
    queryKey: [...queryKey, 'installations'],
    queryFn: ({ signal }) => api.extensions(signal),
    refetchInterval: (q) =>
      q.state.data?.installations.some((i) => BUSY.includes(i.state)) ? 3000 : false,
  });
  const error = catalog.error ?? installations.error;
  const data = useMemo(
    () =>
      catalog.data && installations.data
        ? {
            releases: catalog.data.releases,
            installed: installations.data.installations,
            newest: newestReleases(catalog.data.releases),
          }
        : undefined,
    [catalog.data, installations.data],
  );
  return {
    data,
    error,
    retry: () => {
      void catalog.refetch();
      void installations.refetch();
    },
  };
}

/** Refreshes extensions and the schema, which an install or mapping can change. */
export function useRefreshExtensions() {
  const client = useQueryClient(),
    { session } = useWorkspace();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: [session.workspace.id, 'schema'] }),
    ]);
}

/** The release an installation runs, if this server still offers it. */
export const installedRelease = (releases: Release[], installation: Installation) =>
  releases.find(
    (r) =>
      r.manifest.universalId === installation.registrationId &&
      r.manifest.version === installation.version,
  );

/** A newer release than the installed one, if there is one to upgrade to. */
export function upgradeFor(newest: Map<string, Release>, installation: Installation) {
  const candidate = newest.get(installation.registrationId);
  return candidate &&
    installation.state !== 'configuring' &&
    !isGone(installation) &&
    compareVersions(candidate.manifest.version, installation.version) > 0
    ? candidate
    : undefined;
}

/** Whether the runtime that runs this extension is missing while it should be running. */
export const runtimeMissing = (installation: Installation) =>
  installation.runtimeAvailability?.state === 'unavailable' &&
  ['active', ...BUSY].includes(installation.state);

/** The one status people see first: the state, or what needs them. */
export function status(installation: Installation): { label: string; tone: Tone } {
  if (installation.state === 'configuring')
    return { label: 'Waiting for your review', tone: 'pending' };
  if (installation.state === 'setup_failed') return { label: 'Setup failed', tone: 'error' };
  if (installation.state === 'active' && (installation.lastError || runtimeMissing(installation)))
    return { label: 'Needs attention', tone: 'error' };
  if (installation.state === 'active') return { label: 'Active', tone: 'success' };
  if (BUSY.includes(installation.state))
    return { label: stateLabel(installation.state), tone: 'pending' };
  return { label: stateLabel(installation.state), tone: 'neutral' };
}

/** Plain words for an installation's last error. */
export const errorText = (code: string) =>
  code === 'cursor_expired'
    ? 'Change history expired. This extension needs a catch-up scan before triggers can resume.'
    : `Needs attention: ${code.replaceAll('_', ' ')}`;

/** One installation's detail read, which carries its approved mapping. */
export const detailKey = (id: string) => [...queryKey, 'detail', id];

/** Whether the release has settings a person fills in for the whole workspace. */
export const hasInstallationSettings = (release: Release) =>
  Object.values(release.manifest.settings).some(
    (d) => !d.generated && (d.level ?? 'installation') === 'installation',
  );

/** Settings to start a form from: the release's defaults, then what the installation has. */
export const initialSettings = (
  release: Release,
  installation?: Installation,
): Installation['settings'] => ({
  ...Object.fromEntries(
    Object.entries(release.manifest.settings)
      .filter(
        ([, def]) =>
          def.level !== 'connection' &&
          !def.secret &&
          (def.default !== undefined || def.type === 'boolean'),
      )
      .map(([key, def]) => [key, def.default ?? false]),
  ),
  ...installation?.settings,
});

/** Whether a workspace-level reconnect can change anything for this release. */
export const canReconnect = (release: Release, installation: Installation) =>
  release.manifest.connection === 'workspace' &&
  installation.state !== 'configuring' &&
  !isGone(installation) &&
  (!!release.manifest.source ||
    Object.values(release.manifest.settings).some((setting) => setting.reconnect));

/** What the extension may do, in plain words. */
export const accessText = (
  scopes: readonly string[],
  actor: string,
  uses: readonly string[] = [],
) =>
  `It can ${scopes.join(' and ')} workspace CRM data. Its changes are recorded as made by an ${actor}.${
    uses.includes('model') ? ` ${MODEL_USE_NOTICE.replace('This extension', 'It')}` : ''
  }`;
