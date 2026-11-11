import type { SchemaOperation } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccount } from '../accounts/context.js';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Button,
  CopyButton,
  Dialog,
  Empty,
  Input,
  Label,
  Muted,
  Notice,
  Page,
  Panel,
  Row,
  SelectMenu,
  Stack,
} from '../ui/index.js';
import { describeOperation } from './schema/schema-model.js';
import { QueryError } from './state.js';

type Release = Awaited<ReturnType<typeof api.extensionCatalog>>['releases'][number];
type Installation = Awaited<ReturnType<typeof api.extensions>>['installations'][number];
type Settings = Installation['settings'];
type Preview = Awaited<ReturnType<typeof api.previewExtension>>;
type Plan = { preview: Preview; input: Parameters<typeof api.previewExtension>[0]; key: string };
const queryKey = ['extensions'];
const stateLabel = (state: string) =>
  state.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

export function ExtensionsPage() {
  const accountState = useAccount();
  const { session } = useWorkspace(),
    client = useQueryClient();
  const catalog = useQuery({
    queryKey: [...queryKey, 'catalog'],
    queryFn: ({ signal }) => api.extensionCatalog(signal),
  });
  const installations = useQuery({
    queryKey: [...queryKey, 'installations'],
    queryFn: ({ signal }) => api.extensions(signal),
    refetchInterval: (q) =>
      q.state.data?.installations.some((i) =>
        ['installing', 'upgrading', 'uninstalling'].includes(i.state),
      )
        ? 3000
        : false,
  });
  const [selection, setSelection] = useState<{
    release: Release;
    installation?: Installation;
    reconnect?: boolean;
  } | null>(null);
  const [runs, setRuns] = useState<Installation | null>(null);
  const [credentials, setCredentials] = useState<Installation | null>(null);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: [session.workspace.id, 'schema'] }),
    ]);
  const action = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'enable' | 'disable' | 'uninstall' }) =>
      action === 'enable'
        ? api.enableExtension(id)
        : action === 'disable'
          ? api.disableExtension(id)
          : api.uninstallExtension(id),
    onSuccess: refresh,
  });
  const admin = canMutate(session, 'admin');
  if (catalog.error || installations.error)
    return (
      <Page title="Extensions">
        <QueryError
          error={catalog.error ?? installations.error ?? new Error('Could not load extensions')}
          retry={() => {
            void catalog.refetch();
            void installations.refetch();
          }}
        />
      </Page>
    );
  if (!catalog.data || !installations.data)
    return (
      <Page title="Extensions">
        <Notice>Loading extensions…</Notice>
      </Page>
    );
  const installed = installations.data.installations;
  const newest = new Map<string, Release>();
  for (const release of catalog.data.releases) {
    const previous = newest.get(release.manifest.universalId);
    if (
      !previous ||
      release.manifest.version.localeCompare(previous.manifest.version, 'en', { numeric: true }) > 0
    )
      newest.set(release.manifest.universalId, release);
  }
  return (
    <Page
      title="Extensions"
      description="Connect services to this workspace and review their access and activity."
    >
      <Stack>
        {action.error ? <Notice>{action.error.message}</Notice> : null}
        {!catalog.data.releases.length && !installed.length ? (
          <Empty
            title="No extensions available"
            description="Your operator has not made any extensions available on this server."
          />
        ) : null}
        {installed.map((installation) => {
          const release = catalog.data.releases.find(
            (r) =>
              r.manifest.universalId === installation.registrationId &&
              r.manifest.version === installation.version,
          );
          return (
            <Panel key={installation.id} title={release?.manifest.name ?? 'Unavailable extension'}>
              <Stack>
                <p>
                  {stateLabel(installation.state)} · Version {installation.version}
                </p>
                {installation.runtimeAvailability?.state === 'unavailable' &&
                ['active', 'installing', 'upgrading', 'uninstalling'].includes(
                  installation.state,
                ) ? (
                  <Notice>
                    Your server cannot run this extension right now. Pending work is saved. Contact
                    your server operator to restore it.
                  </Notice>
                ) : null}
                {installation.lastError ? (
                  <Notice>
                    {installation.lastError === 'cursor_expired'
                      ? 'Change history expired. This extension needs a catch-up scan before triggers can resume.'
                      : `Needs attention: ${installation.lastError.replaceAll('_', ' ')}`}
                  </Notice>
                ) : null}
                <Muted>
                  Access: {installation.grantedScopes.join(' and ')} workspace CRM data. Writes are
                  attributed to this {installation.grantedActor}.
                </Muted>
                {release?.manifest.source ? (
                  <SourceSyncStatus installationId={installation.id} />
                ) : null}
                <Row>
                  <Button onClick={() => setRuns(installation)}>View runs</Button>
                  {admin && release?.manifest.execution === 'standalone' ? (
                    <Button onClick={() => setCredentials(installation)}>App credentials</Button>
                  ) : null}
                  {admin && release ? (
                    <Button onClick={() => setSelection({ release, installation })}>
                      Settings
                    </Button>
                  ) : null}
                  {admin &&
                  release &&
                  !['uninstalled', 'uninstalling'].includes(installation.state) &&
                  (release.manifest.source ||
                    Object.values(release.manifest.settings).some(
                      (setting) => setting.reconnect,
                    )) ? (
                    <Button
                      onClick={() => setSelection({ release, installation, reconnect: true })}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                  {admin && ['disabled', 'setup_failed'].includes(installation.state) ? (
                    <Button
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: installation.id, action: 'enable' })}
                    >
                      Enable
                    </Button>
                  ) : null}
                  {admin &&
                  ['active', 'installing', 'upgrading', 'setup_failed'].includes(
                    installation.state,
                  ) ? (
                    <Button
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: installation.id, action: 'disable' })}
                    >
                      Disable
                    </Button>
                  ) : null}
                  {admin && !['uninstalled', 'uninstalling'].includes(installation.state) ? (
                    <Button
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: installation.id, action: 'uninstall' })}
                    >
                      Uninstall
                    </Button>
                  ) : null}
                </Row>
                <Muted small>
                  Uninstall revokes access and retains imported CRM data, fields, and saved views.
                </Muted>
              </Stack>
            </Panel>
          );
        })}
        {[...newest.values()].map((release) => {
          const installation = installed.find(
            (i) => i.registrationId === release.manifest.universalId,
          );
          const upgrade =
            installation &&
            installation.state !== 'uninstalled' &&
            release.manifest.version.localeCompare(installation.version, 'en', { numeric: true }) >
              0;
          if (installation && installation.state !== 'uninstalled' && !upgrade) return null;
          return (
            <Panel
              key={`${release.manifest.universalId}:${release.manifest.version}`}
              title={`${release.manifest.name} · ${release.manifest.version}`}
            >
              <Stack>
                <p>{release.manifest.description}</p>
                {admin ? (
                  <Button
                    onClick={() =>
                      setSelection({ release, ...(installation ? { installation } : {}) })
                    }
                  >
                    {upgrade ? 'Review upgrade' : 'Set up'}
                  </Button>
                ) : (
                  <Muted>A workspace admin can connect this service.</Muted>
                )}
              </Stack>
            </Panel>
          );
        })}
      </Stack>
      {selection ? (
        <ExtensionSettings
          key={`${selection.release.digest}:${selection.installation?.id ?? 'new'}:${selection.reconnect ? 'reconnect' : 'settings'}`}
          {...selection}
          onClose={() => setSelection(null)}
          onSaved={() => {
            setSelection(null);
            void refresh();
          }}
        />
      ) : null}
      {credentials ? (
        <InstallationCredentials
          keyMode={!accountState}
          installation={installed.find((i) => i.id === credentials.id) ?? credentials}
          onClose={() => setCredentials(null)}
        />
      ) : null}
      {runs ? <RunDialog installation={runs} admin={admin} onClose={() => setRuns(null)} /> : null}
    </Page>
  );
}

function SettingFields({
  release,
  values,
  secrets,
  onChange,
  onSecret,
  existing,
  references,
  allowConnectionEdit = false,
}: {
  release: Release;
  values: Settings;
  secrets: Record<string, string>;
  onChange: (key: string, value: string | boolean | number) => void;
  onSecret: (key: string, value: string) => void;
  existing?: Installation;
  references: Record<string, string>;
  allowConnectionEdit?: boolean;
}) {
  return (
    <>
      {Object.entries(release.manifest.settings)
        .filter(([, definition]) => !definition.generated)
        .map(([key, definition]) => {
          const locked =
            !!existing && !allowConnectionEdit && (definition.secret || definition.reconnect);
          return (
            <Label key={key}>
              {definition.label}
              {definition.required ? ' (required)' : ''}
              {definition.secret ? (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] ?? ''}
                  disabled={locked}
                  required={definition.required && !existing?.secrets?.[key] && !references[key]}
                  placeholder={
                    existing?.secrets?.[key]
                      ? 'Connected'
                      : references[key]
                        ? 'Provided for approval'
                        : ''
                  }
                  onChange={(e) => onSecret(key, e.target.value)}
                />
              ) : definition.options ? (
                <fieldset disabled={locked}>
                  <SelectMenu
                    label={definition.label}
                    value={typeof values[key] === 'string' ? String(values[key]) : null}
                    options={definition.options.map((value) => ({
                      value,
                      label: stateLabel(value),
                    }))}
                    onChange={(value) => onChange(key, value)}
                    fill
                  />
                </fieldset>
              ) : definition.type === 'boolean' ? (
                <Input
                  type="checkbox"
                  checked={values[key] === true}
                  required={definition.consent}
                  disabled={locked}
                  onChange={(e) => onChange(key, e.target.checked)}
                />
              ) : (
                <Input
                  type={definition.type === 'number' ? 'number' : 'text'}
                  value={String(values[key] ?? '')}
                  disabled={locked}
                  required={definition.required}
                  onChange={(e) =>
                    onChange(
                      key,
                      definition.type === 'number' ? e.target.valueAsNumber : e.target.value,
                    )
                  }
                />
              )}
              {definition.description ? <Muted small>{definition.description}</Muted> : null}
              {locked ? (
                <Muted small>Use Reconnect to change credentials or account settings.</Muted>
              ) : null}
            </Label>
          );
        })}
    </>
  );
}

export function ExtensionSettings({
  release,
  installation,
  reconnect = false,
  onClose,
  onSaved,
}: {
  release: Release;
  installation?: Installation;
  reconnect?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { schema } = useWorkspace();
  const retained = installation?.state !== 'uninstalled' ? installation : undefined;
  const upgrade = !!retained && retained.version !== release.manifest.version;
  const [values, setValues] = useState<Settings>(() => ({
    ...Object.fromEntries(
      Object.entries(release.manifest.settings)
        .filter(([, def]) => !def.secret && (def.default !== undefined || def.type === 'boolean'))
        .map(([key, def]) => [key, def.default ?? false]),
    ),
    ...installation?.settings,
  }));
  const [replaceSourceAccount, setReplaceSourceAccount] = useState(false);
  const grantIncrease =
    !!retained &&
    ((release.manifest.requestedActor === 'integration' && retained.grantedActor === 'agent') ||
      release.manifest.scopes.some((scope) => !retained.grantedScopes.includes(scope)));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [draftInstallationId, setDraftInstallationId] = useState(installation?.id);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const review = useMutation({
    mutationFn: async () => {
      const refs = { ...references };
      let draftId = draftInstallationId;
      for (const [name, value] of Object.entries(secrets)) {
        if (!value) continue;
        const staged = await api.stageExtensionSecret({
          registrationId: release.manifest.universalId,
          version: release.manifest.version,
          ...(draftId ? { installationId: draftId } : {}),
          name,
          value,
        });
        draftId = staged.installationId;
        setDraftInstallationId(staged.installationId);
        refs[name] = staged.pendingSecretId;
        setReferences((previous) => ({ ...previous, [name]: staged.pendingSecretId }));
        setSecrets((previous) => ({ ...previous, [name]: '' }));
      }
      const input = {
        ...(retained ? { installationId: retained.id } : {}),
        registrationId: release.manifest.universalId,
        version: release.manifest.version,
        ...(reconnect ? { reconnect: true, replaceSourceAccount } : {}),
        ...(grantIncrease ? { grantChange: true } : {}),
        settings: values,
        ...(Object.keys(refs).length ? { secretRefs: refs } : {}),
      };
      const preview = await api.previewExtension(input);
      setPlan({ input, preview, key: crypto.randomUUID() });
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (retained && !upgrade && !reconnect)
        return api.updateExtensionSettings(retained.id, {
          expectedRevision: retained.settingsRevision,
          settings: values,
        });
      if (!plan) throw new Error('Review the installation before approval.');
      if (reconnect && retained)
        return api.reconnectExtension(
          retained.id,
          { ...plan.input, planDigest: plan.preview.planDigest },
          plan.key,
        );
      return upgrade && installation
        ? api.upgradeExtension(
            installation.id,
            { ...plan.input, planDigest: plan.preview.planDigest },
            plan.key,
          )
        : api.installExtension({ ...plan.input, planDigest: plan.preview.planDigest }, plan.key);
    },
    onSuccess: onSaved,
  });
  const busy = review.isPending || save.isPending;
  const error = save.error ?? review.error;
  const updating = !!retained && !upgrade && !reconnect;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`${release.manifest.name} ${reconnect ? 'reconnect' : updating ? 'settings' : upgrade ? 'upgrade' : 'setup'}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (updating) save.mutate();
          else review.mutate();
        }}
      >
        <Stack>
          <p>{release.manifest.description}</p>
          {error ? <Notice>{error.message}</Notice> : null}
          <fieldset disabled={busy || !!plan} className="flex flex-col gap-3">
            <SettingFields
              release={release}
              values={values}
              secrets={secrets}
              {...(retained ? { existing: retained } : {})}
              references={references}
              allowConnectionEdit={reconnect}
              onChange={(key, value) => {
                setValues((v) => ({ ...v, [key]: value }));
                setPlan(null);
              }}
              onSecret={(key, value) => {
                setSecrets((v) => ({ ...v, [key]: value }));
                setReferences((v) => {
                  const next = { ...v };
                  delete next[key];
                  return next;
                });
                setPlan(null);
              }}
            />
            {reconnect && release.manifest.source ? (
              <Label>
                <Input
                  type="checkbox"
                  checked={replaceSourceAccount}
                  onChange={(event) => setReplaceSourceAccount(event.target.checked)}
                />
                Use a different provider account
                <Muted small>
                  Retire the previous account binding and callback addresses. Imported evidence
                  stays in its existing namespace.
                </Muted>
              </Label>
            ) : null}
          </fieldset>
          {updating ? (
            <Muted>
              Saving settings disables this connection and stops its pending runs. Enable it again
              when ready.
            </Muted>
          ) : null}
          {plan ? (
            <Panel title="Review access and changes">
              <Stack>
                <p>
                  This service can {plan.preview.grants.scopes.join(' and ')} workspace CRM data.
                  Its writes are attributed to an {plan.preview.grants.actor}.
                </p>
                {plan.preview.previousGrants ? (
                  <Notice>
                    This approval changes access from{' '}
                    {plan.preview.previousGrants.scopes.join(' and ')} as an{' '}
                    {plan.preview.previousGrants.actor} to{' '}
                    {plan.preview.grants.scopes.join(' and ')} as an {plan.preview.grants.actor}.
                  </Notice>
                ) : null}
                <p>
                  People creation:{' '}
                  {String(
                    plan.input.settings.createPeople ?? release.manifest.createPeople,
                  ).replaceAll('_', ' ')}
                  . When source content is deleted:{' '}
                  {release.manifest.onSourceDelete === 'keep'
                    ? 'keep imported evidence'
                    : 'retract its evidence and derived claims'}
                  .
                </p>
                {plan.preview.operations.length ? (
                  <ul className="list-disc pl-5">
                    {plan.preview.operations.map((operation) => (
                      <li key={JSON.stringify(operation)}>
                        {describeOperation(operation as SchemaOperation, schema.objects)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No schema changes.</Muted>
                )}
                {plan.preview.views.map((view) => (
                  <p key={view.universalId}>
                    {view.action === 'create' ? 'Create' : 'Retain'} saved view: {view.name}
                  </p>
                ))}
                {plan.preview.warnings.map((warning) => (
                  <Notice key={warning}>{warning}</Notice>
                ))}
                <Row>
                  <Button variant="primary" disabled={busy} onClick={() => save.mutate()}>
                    {save.isPending
                      ? 'Approving…'
                      : reconnect
                        ? 'Approve reconnect'
                        : grantIncrease
                          ? 'Approve access and upgrade'
                          : upgrade
                            ? 'Approve upgrade'
                            : 'Approve installation'}
                  </Button>
                  <Button disabled={busy} onClick={() => setPlan(null)}>
                    Edit settings
                  </Button>
                </Row>
              </Stack>
            </Panel>
          ) : (
            <Button type="submit" variant="primary" disabled={busy}>
              {busy
                ? 'Working…'
                : updating
                  ? 'Save settings'
                  : reconnect
                    ? 'Review reconnect'
                    : 'Review installation'}
            </Button>
          )}
        </Stack>
      </form>
    </Dialog>
  );
}

function RunDialog({
  installation,
  admin,
  onClose,
}: {
  installation: Installation;
  admin: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const runs = useQuery({
    queryKey: [...queryKey, 'runs', installation.id, cursor],
    queryFn: ({ signal }) =>
      api.extensionRuns(installation.id, { signal, ...(cursor ? { cursor } : {}) }),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (runId: string) =>
      api.retryExtensionRun(installation.id, runId, crypto.randomUUID()),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Extension runs"
    >
      <Stack>
        {runs.error ? <QueryError error={runs.error} retry={() => void runs.refetch()} /> : null}
        {retry.error ? <Notice>{retry.error.message}</Notice> : null}
        {!runs.data ? (
          <Muted>Loading runs…</Muted>
        ) : !runs.data.runs.length ? (
          <Muted>No runs yet.</Muted>
        ) : (
          <ul aria-label="Extension runs" className="flex flex-col gap-3">
            {runs.data.runs.map((run) => (
              <li key={run.id} className="rounded-md border p-3">
                <Row>
                  <span>
                    {stateLabel(run.status)} · Attempt {run.attempt}
                  </span>
                  <Muted small>{new Date(run.createdAt).toLocaleString()}</Muted>
                  {run.code ? <span>{run.code.replaceAll('_', ' ')}</span> : null}
                  {admin && run.status === 'failed' ? (
                    <Button disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>
                      Retry run
                    </Button>
                  ) : null}
                </Row>
              </li>
            ))}
          </ul>
        )}
        <Row>
          {cursor ? <Button onClick={() => setCursor(undefined)}>Newest runs</Button> : null}
          {runs.data?.nextCursor ? (
            <Button onClick={() => setCursor(runs.data?.nextCursor ?? undefined)}>
              Older runs
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Dialog>
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
    <section aria-label="Source sync progress">
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
        A completed scan can still have pending or failed imports. View runs for details.
      </Muted>
    </section>
  );
}

export function InstallationCredentials({
  installation,
  onClose,
  keyMode = true,
}: {
  installation: Installation;
  onClose: () => void;
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
    <Dialog
      open
      title="App credentials"
      onOpenChange={(open) => {
        if (!open) {
          setIssued(null);
          onClose();
        }
      }}
    >
      <Stack>
        <p>
          These credentials work for this app in this workspace. They have no access to personal
          memory.
        </p>
        {!keyMode ? (
          <Muted>
            Start a connection from the app to approve access. Revoke its connection here to
            disconnect it.
          </Muted>
        ) : null}
        {credentials.error ? (
          <QueryError error={credentials.error} retry={() => void credentials.refetch()} />
        ) : null}
        {issue.error ? <Notice>{issue.error.message}</Notice> : null}
        {revoke.error ? <Notice>{revoke.error.message}</Notice> : null}
        {!keyMode ? null : issued ? (
          <Stack>
            <Notice>Copy this key now. It is shown only once.</Notice>
            <Input aria-label="Installation key" readOnly value={issued.key} />
            <CopyButton value={issued.key} label="Copy installation key" />
          </Stack>
        ) : (
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
            <Button
              disabled={installation.state !== 'active' || !selected.length || issue.isPending}
              onClick={() => issue.mutate()}
            >
              {issue.isPending ? 'Creating key…' : 'Create installation key'}
            </Button>
            {installation.state !== 'active' ? (
              <Muted>Enable this app before creating a new key.</Muted>
            ) : null}
          </Stack>
        )}
        {credentials.data?.credentials.length ? (
          <ul aria-label="App credentials">
            {credentials.data.credentials.map((credential) => (
              <li key={credential.id}>
                <Row>
                  <span>
                    {credential.prefix ?? 'OAuth connection'} ·{' '}
                    {credential.active ? 'Active' : 'Inactive'}
                  </span>
                  {credential.active ? (
                    <Button
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(credential.id)}
                    >
                      Revoke {credential.prefix ?? 'connection'}
                    </Button>
                  ) : null}
                </Row>
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          onClick={() => {
            setIssued(null);
            onClose();
          }}
        >
          Done
        </Button>
      </Stack>
    </Dialog>
  );
}
