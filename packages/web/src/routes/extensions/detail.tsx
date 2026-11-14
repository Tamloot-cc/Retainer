import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { useAccount } from '../../accounts/context.js';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  Empty,
  Input,
  Label,
  Loading,
  Menu,
  MenuAction,
  MenuSeparator,
  Muted,
  Notice,
  Page,
  Row,
  Section,
  Stack,
  Tabs,
} from '../../ui/index.js';
import { QueryError, useView } from '../state.js';
import { MemberConnectionPanel } from './connections.js';
import { MappingBindings } from './mapping.js';
import {
  accessText,
  canReconnect,
  detailKey,
  errorText,
  hasInstallationSettings,
  type Installation,
  initialSettings,
  installedRelease,
  isGone,
  queryKey,
  type Release,
  runtimeMissing,
  stateLabel,
  status,
  upgradeFor,
  useExtensions,
  useRefreshExtensions,
} from './model.js';
import { SettingFields } from './setting-fields.js';

type Settings = Installation['settings'];
type Tab = 'overview' | 'connections' | 'mapping' | 'settings' | 'runs' | 'credentials';

/** `/extensions/:id`: one installed extension, its state up top and the rest in tabs. */
export function ExtensionPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, error, retry } = useExtensions();
  if (error)
    return (
      <Page eyebrow="Extensions" title="Extension">
        <QueryError error={error} retry={retry} />
      </Page>
    );
  if (!data)
    return (
      <Page eyebrow="Extensions" title="Extension">
        <Loading>Loading extension…</Loading>
      </Page>
    );
  const installation = data.installed.find((i) => i.id === id);
  if (!installation)
    return (
      <Page eyebrow="Extensions" title="Extension">
        <Empty
          title="Extension not found"
          description="It is not installed in this workspace, or the address is wrong."
        />
        <Link to="/extensions" className="text-sm underline">
          All extensions
        </Link>
      </Page>
    );
  return (
    <InstalledExtension
      installation={installation}
      release={installedRelease(data.releases, installation)}
      upgrade={upgradeFor(data.newest, installation)}
    />
  );
}

function InstalledExtension({
  installation,
  release,
  upgrade,
}: {
  installation: Installation;
  release: Release | undefined;
  upgrade: Release | undefined;
}) {
  const { session } = useWorkspace();
  const accountState = useAccount();
  const navigate = useNavigate();
  const { search, setSearch } = useView();
  const refresh = useRefreshExtensions();
  const admin = canMutate(session, 'admin');
  const [runsConnection, setRunsConnection] = useState<string | undefined>();
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // Kept here: the settings form starts again from each new revision, saved or not.
  const [savedRevision, setSavedRevision] = useState<number | undefined>();
  const action = useMutation({
    mutationFn: (kind: 'enable' | 'disable' | 'uninstall') =>
      kind === 'enable'
        ? api.enableExtension(installation.id)
        : kind === 'disable'
          ? api.disableExtension(installation.id)
          : api.uninstallExtension(installation.id),
    onSuccess: async (_, kind) => {
      await refresh();
      if (kind === 'uninstall') void navigate({ to: '/extensions' });
    },
  });
  const manifest = release?.manifest;
  const name = manifest?.name ?? 'Unavailable extension';
  const gone = isGone(installation);
  const tabs: { value: Tab; label: string; hint?: string }[] = [
    { value: 'overview', label: 'Overview' },
    ...(manifest?.connection === 'member'
      ? [
          {
            value: 'connections' as const,
            label: 'Connections',
            hint: 'Each person connects their own account. What it brings in is shared with the workspace.',
          },
        ]
      : []),
    ...(manifest?.mapping && !gone
      ? [
          {
            value: 'mapping' as const,
            label: 'Field mapping',
            hint: 'Which field each value this extension finds is written to.',
          },
        ]
      : []),
    ...(admin && manifest && !gone ? [{ value: 'settings' as const, label: 'Settings' }] : []),
    {
      value: 'runs',
      label: 'Runs',
      hint: 'Each time the extension did work for this workspace, and how it ended.',
    },
    ...(admin && manifest?.execution === 'standalone'
      ? [
          {
            value: 'credentials' as const,
            label: 'App credentials',
            hint: 'Keys and connections the app uses to reach this workspace.',
          },
        ]
      : []),
  ];
  // With a connection per person, connecting your own account is what you came for.
  const opening: Tab = manifest?.connection === 'member' ? 'connections' : 'overview';
  const tab: Tab = tabs.some((t) => t.value === search.tab) ? (search.tab as Tab) : opening;
  const { label, tone } = status(installation);
  const reconnect = admin && release && canReconnect(release, installation);
  const canEnable = admin && ['disabled', 'setup_failed'].includes(installation.state);
  const canDisable =
    admin && ['active', 'installing', 'upgrading', 'setup_failed'].includes(installation.state);
  const showMenu = reconnect || canEnable || canDisable || (admin && !gone);
  return (
    <Page
      eyebrow="Extensions"
      title={name}
      {...(manifest ? { description: manifest.description } : {})}
      actions={
        <>
          {admin && installation.state === 'configuring' ? (
            <Button variant="primary" asChild>
              <Link
                to="/extensions/new/$registration"
                params={{ registration: installation.registrationId }}
              >
                Continue setup
              </Link>
            </Button>
          ) : null}
          {admin && upgrade ? (
            <Button size="small" variant="primary" asChild>
              <Link to="/extensions/$id/upgrade" params={{ id: installation.id }}>
                Upgrade to {upgrade.manifest.version}
              </Link>
            </Button>
          ) : null}
          {showMenu ? (
            <Menu
              label="Extension actions"
              align="end"
              trigger={
                <Button size="iconSmall" aria-label="Extension actions" disabled={action.isPending}>
                  <Ellipsis size={16} />
                </Button>
              }
            >
              {reconnect ? (
                <MenuAction
                  onSelect={() =>
                    void navigate({
                      to: '/extensions/$id/reconnect',
                      params: { id: installation.id },
                    })
                  }
                >
                  Reconnect
                </MenuAction>
              ) : null}
              {canEnable ? (
                <MenuAction onSelect={() => action.mutate('enable')}>Enable</MenuAction>
              ) : null}
              {canDisable ? (
                <MenuAction onSelect={() => action.mutate('disable')}>Disable</MenuAction>
              ) : null}
              {admin && !gone ? (
                <>
                  <MenuSeparator />
                  <MenuAction destructive onSelect={() => setConfirmUninstall(true)}>
                    Uninstall
                  </MenuAction>
                </>
              ) : null}
            </Menu>
          ) : null}
        </>
      }
    >
      <Row>
        <Badge tone={tone}>{label}</Badge>
        <Muted>Version {installation.version}</Muted>
      </Row>
      {action.error ? <Notice error>{action.error.message}</Notice> : null}
      {upgrade ? (
        <Notice>
          Version {upgrade.manifest.version} is available. Review what it changes before you
          upgrade.
        </Notice>
      ) : null}
      {runtimeMissing(installation) ? (
        <Notice>
          Your server cannot run this extension right now. Pending work is saved. Contact your
          server operator to restore it.
        </Notice>
      ) : null}
      {installation.lastError ? <Notice error>{errorText(installation.lastError)}</Notice> : null}
      <Tabs
        items={tabs}
        value={tab}
        onChange={(value) => void setSearch({ tab: value === opening ? undefined : value })}
      />
      {tab === 'overview' ? (
        <Overview installation={installation} release={release} />
      ) : tab === 'connections' && release ? (
        <MemberConnectionPanel
          installation={installation}
          release={release}
          admin={admin}
          onChanged={refresh}
          onRuns={(connection) => {
            setRunsConnection(connection);
            void setSearch({ tab: 'runs' });
          }}
        />
      ) : tab === 'mapping' && release ? (
        <MappingSummary release={release} installation={installation} admin={admin} />
      ) : tab === 'settings' && release ? (
        <SettingsForm
          key={installation.settingsRevision}
          release={release}
          installation={installation}
          reconnect={!!reconnect}
          saved={savedRevision === installation.settingsRevision}
          onSaved={(revision) => {
            setSavedRevision(revision);
            return refresh();
          }}
          onDismiss={() => setSavedRevision(undefined)}
        />
      ) : tab === 'runs' ? (
        <RunList
          installation={installation}
          admin={admin}
          {...(runsConnection ? { connection: runsConnection } : {})}
          onAll={() => setRunsConnection(undefined)}
        />
      ) : tab === 'credentials' ? (
        <InstallationCredentials installation={installation} keyMode={!accountState} />
      ) : null}
      {confirmUninstall ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !action.isPending) setConfirmUninstall(false);
          }}
          title={`Uninstall ${name}?`}
        >
          <Stack>
            <p className="text-sm">
              It loses its access to this workspace and stops running. The data it brought in, the
              fields it added and its saved views stay.
            </p>
            <Row>
              <Button
                variant="destructive"
                disabled={action.isPending}
                onClick={() => action.mutate('uninstall')}
              >
                {action.isPending ? 'Uninstalling…' : 'Uninstall'}
              </Button>
              <Button disabled={action.isPending} onClick={() => setConfirmUninstall(false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Dialog>
      ) : null}
    </Page>
  );
}

function Overview({
  installation,
  release,
}: {
  installation: Installation;
  release: Release | undefined;
}) {
  return (
    <Stack>
      <Section title="Access">
        <p className="text-sm">
          {accessText(installation.grantedScopes, installation.grantedActor)}
        </p>
      </Section>
      {release?.manifest.source && release.manifest.connection === 'workspace' ? (
        <Section title="Sync">
          <SourceSyncStatus installationId={installation.id} />
        </Section>
      ) : null}
      <Section title="Where it runs">
        {release ? (
          <p className="text-sm">
            {release.manifest.execution === 'standalone'
              ? 'As its own app, which reaches this workspace with its app credentials.'
              : 'On this server.'}
          </p>
        ) : (
          <Muted>This server no longer offers the installed version of this extension.</Muted>
        )}
      </Section>
    </Stack>
  );
}

/** Settings that apply without a review: credentials and account settings need Reconnect. */
function SettingsForm({
  release,
  installation,
  reconnect,
  saved,
  onSaved,
  onDismiss,
}: {
  release: Release;
  installation: Installation;
  reconnect: boolean;
  /** Whether this revision is the one just saved here. */
  saved: boolean;
  onSaved: (revision: number) => Promise<unknown>;
  onDismiss: () => void;
}) {
  const [values, setValues] = useState<Settings>(() => initialSettings(release, installation));
  const save = useMutation({
    mutationFn: () =>
      api.updateExtensionSettings(installation.id, {
        expectedRevision: installation.settingsRevision,
        settings: values,
      }),
    onSuccess: (updated) => onSaved(updated.settingsRevision),
  });
  if (!hasInstallationSettings(release))
    return <Empty quiet title="This extension has no settings" />;
  return (
    <form
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error ? <Notice error>{save.error.message}</Notice> : null}
      {saved ? <Notice onDismiss={onDismiss}>Settings saved.</Notice> : null}
      <fieldset disabled={save.isPending} className="flex flex-col gap-4">
        <SettingFields
          release={release}
          values={values}
          secrets={{}}
          existing={installation}
          references={{}}
          onChange={(key, value) => {
            setValues((v) => ({ ...v, [key]: value }));
            onDismiss();
          }}
          onSecret={() => {}}
        />
      </fieldset>
      <Muted>
        Saving stops pending runs and starts again with the new values. The connection stays on and
        its app keys keep working.
      </Muted>
      <Row>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        {reconnect ? (
          <Button asChild>
            <Link to="/extensions/$id/reconnect" params={{ id: installation.id }}>
              Change credentials
            </Link>
          </Button>
        ) : null}
      </Row>
    </form>
  );
}

/** The approved mapping of an installation, with what needs a remap. */
function MappingSummary({
  release,
  installation,
  admin,
}: {
  release: Release;
  installation: Installation;
  admin: boolean;
}) {
  const navigate = useNavigate();
  const suggest = useMutation({
    mutationFn: async () => {
      await api.configureExtension(installation.id);
      void navigate({ to: '/extensions/$id/mapping', params: { id: installation.id } });
    },
  });
  const detail = useQuery({
    queryKey: detailKey(installation.id),
    queryFn: ({ signal }) => api.extension(installation.id, signal),
  });
  const mapping = release.manifest.mapping;
  if (!mapping) return null;
  if (detail.error) return <QueryError error={detail.error} retry={() => void detail.refetch()} />;
  const view = detail.data?.mapping;
  if (!view) return <Muted>Loading field mapping…</Muted>;
  const broken = view.outputs.some((o) => o.status !== 'ok');
  return (
    <section aria-label="Approved field mapping" className="flex flex-col gap-3">
      {suggest.error ? <Notice error>{suggest.error.message}</Notice> : null}
      <MappingBindings mapping={mapping} bindings={view.outputs} />
      {broken ? (
        <Notice>
          A mapped field was deleted or changed. Its value is not written until you remap or skip
          it.
        </Notice>
      ) : null}
      {admin ? (
        <Row>
          {installation.state === 'active' &&
          release.manifest.functions.some((fn) => fn.trigger.kind === 'configure') ? (
            <Button disabled={suggest.isPending} onClick={() => suggest.mutate()}>
              Suggest mapping
            </Button>
          ) : null}
          <Button asChild>
            <Link to="/extensions/$id/mapping" params={{ id: installation.id }}>
              Edit mapping
            </Link>
          </Button>
        </Row>
      ) : null}
    </section>
  );
}

function RunList({
  installation,
  connection,
  admin,
  onAll,
}: {
  installation: Installation;
  connection?: string;
  admin: boolean;
  onAll: () => void;
}) {
  const client = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const runs = useQuery({
    queryKey: [...queryKey, 'runs', installation.id, connection, cursor],
    queryFn: ({ signal }) =>
      api.extensionRuns(installation.id, {
        signal,
        ...(connection ? { connection } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (runId: string) =>
      api.retryExtensionRun(installation.id, runId, crypto.randomUUID()),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  return (
    <Stack>
      {connection ? <Notice onDismiss={onAll}>Showing the runs of one connection.</Notice> : null}
      {runs.error ? <QueryError error={runs.error} retry={() => void runs.refetch()} /> : null}
      {retry.error ? <Notice error>{retry.error.message}</Notice> : null}
      {!runs.data ? (
        <Muted>Loading runs…</Muted>
      ) : !runs.data.runs.length ? (
        <Empty quiet title="No runs yet." />
      ) : (
        <ul
          aria-label="Extension runs"
          className="flex flex-col divide-y divide-border rounded-lg border border-border"
        >
          {runs.data.runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <Badge
                tone={
                  run.status === 'failed'
                    ? 'error'
                    : run.status === 'succeeded'
                      ? 'success'
                      : 'neutral'
                }
              >
                {stateLabel(run.status)}
              </Badge>
              <span className="text-sm">Attempt {run.attempt}</span>
              {run.code ? <Muted small>{stateLabel(run.code)}</Muted> : null}
              <span className="ml-auto flex items-center gap-2">
                <Muted small>{new Date(run.createdAt).toLocaleString()}</Muted>
                {admin && run.status === 'failed' ? (
                  <Button
                    size="small"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(run.id)}
                  >
                    Retry run
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Row>
        {cursor ? <Button onClick={() => setCursor(undefined)}>Newest runs</Button> : null}
        {runs.data?.nextCursor ? (
          <Button onClick={() => setCursor(runs.data?.nextCursor ?? undefined)}>Older runs</Button>
        ) : null}
      </Row>
    </Stack>
  );
}

export function SourceSyncStatus({ installationId }: { installationId: string }) {
  const status = useQuery({
    queryKey: [...queryKey, 'source-sync', installationId],
    queryFn: ({ signal }) => api.sourceSyncStatus(installationId, signal),
    refetchInterval: 15000,
  });
  if (status.error) return <QueryError error={status.error} retry={() => void status.refetch()} />;
  if (!status.data) return <Muted>Loading source progress…</Muted>;
  return (
    <section aria-label="Source sync progress" className="flex flex-col gap-1 text-sm">
      <p>
        {status.data.lastSuccessfulScanAt
          ? `Last successful scan: ${new Date(status.data.lastSuccessfulScanAt).toLocaleString()}`
          : 'No successful source scan yet.'}
      </p>
      {status.data.activeScan ? <p>Source scan in progress.</p> : null}
      <p>
        {status.data.pendingItems} pending imports · {status.data.failedItems} failed imports
      </p>
      <Muted small>
        A completed scan can still have pending or failed imports. See Runs for details.
      </Muted>
    </section>
  );
}

export function InstallationCredentials({
  installation,
  keyMode = true,
}: {
  installation: Installation;
  keyMode?: boolean;
}) {
  const client = useQueryClient();
  const [scopes, setScopes] = useState<('read' | 'write')[]>(installation.grantedScopes);
  const [issued, setIssued] = useState<Awaited<ReturnType<typeof api.createExtensionKey>> | null>(
    null,
  );
  const selected = scopes.filter((scope) => installation.grantedScopes.includes(scope));
  const credentials = useQuery({
    queryKey: [...queryKey, 'credentials', installation.id],
    queryFn: ({ signal }) => api.extensionCredentials(installation.id, signal),
  });
  const issue = useMutation({
    mutationFn: () =>
      api.createExtensionKey(installation.id, {
        expectedGeneration: installation.generation,
        scopes: selected,
      }),
    onSuccess: (key) => {
      setIssued(key);
      void client.invalidateQueries({ queryKey });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeExtensionCredential(installation.id, id),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Muted>
        These credentials work for this app in this workspace. They have no access to personal
        memory.
      </Muted>
      {!keyMode ? (
        <Muted>
          Start a connection from the app to approve access. Revoke its connection here to
          disconnect it.
        </Muted>
      ) : null}
      {credentials.error ? (
        <QueryError error={credentials.error} retry={() => void credentials.refetch()} />
      ) : null}
      {issue.error ? <Notice error>{issue.error.message}</Notice> : null}
      {revoke.error ? <Notice error>{revoke.error.message}</Notice> : null}
      {!keyMode ? null : issued ? (
        <Section title="New key">
          <Stack>
            <Notice>Copy this key now. It is shown only once.</Notice>
            <Row nowrap>
              <Input aria-label="Installation key" readOnly value={issued.key} />
              <CopyButton value={issued.key} label="Copy installation key" />
            </Row>
            <Row>
              <Button
                onClick={() => {
                  // The key is gone for good; the next one starts from the full access again.
                  setIssued(null);
                  setScopes(installation.grantedScopes);
                }}
              >
                Done
              </Button>
            </Row>
          </Stack>
        </Section>
      ) : (
        <Section title="Create a key">
          <Stack>
            {installation.grantedScopes.map((scope) => (
              <Label key={scope}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={(event) =>
                    setScopes(
                      event.currentTarget.checked
                        ? [...selected, scope]
                        : selected.filter((s) => s !== scope),
                    )
                  }
                />
                {scope === 'read' ? 'Read workspace data' : 'Write workspace data'}
              </Label>
            ))}
            <Row>
              <Button
                disabled={installation.state !== 'active' || !selected.length || issue.isPending}
                onClick={() => issue.mutate()}
              >
                {issue.isPending ? 'Creating key…' : 'Create installation key'}
              </Button>
            </Row>
            {installation.state !== 'active' ? (
              <Muted>Enable this app before creating a new key.</Muted>
            ) : null}
          </Stack>
        </Section>
      )}
      {credentials.data?.credentials.length ? (
        <Section title="Keys and connections">
          <ul
            aria-label="App credentials"
            className="flex flex-col divide-y divide-border rounded-lg border border-border"
          >
            {credentials.data.credentials.map((credential) => (
              <li key={credential.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {credential.prefix ?? 'OAuth connection'} ·{' '}
                  {credential.active ? 'Active' : 'Inactive'}
                </span>
                {credential.active ? (
                  <Button
                    size="small"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(credential.id)}
                  >
                    Revoke {credential.prefix ?? 'connection'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
