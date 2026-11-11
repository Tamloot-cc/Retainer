import type { SchemaOperation } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import {
  Button,
  Dialog,
  Empty,
  Input,
  Label,
  Muted,
  Notice,
  Page,
  Panel,
  Row,
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
  } | null>(null);
  const [runs, setRuns] = useState<Installation | null>(null);
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
                {installation.lastError ? (
                  <Notice>Needs attention: {installation.lastError.replaceAll('_', ' ')}</Notice>
                ) : null}
                <Muted>
                  Access: {installation.grantedScopes.join(' and ')} workspace CRM data. Writes are
                  attributed to this {installation.grantedActor}.
                </Muted>
                <Row>
                  <Button onClick={() => setRuns(installation)}>View runs</Button>
                  {admin && release ? (
                    <Button onClick={() => setSelection({ release, installation })}>
                      Settings
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
        {catalog.data.releases.map((release) => {
          const installation = installed.find(
            (i) => i.registrationId === release.manifest.universalId,
          );
          const upgrade =
            installation &&
            installation.state !== 'uninstalled' &&
            installation.version !== release.manifest.version;
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
          key={`${selection.release.digest}:${selection.installation?.id ?? 'new'}`}
          {...selection}
          onClose={() => setSelection(null)}
          onSaved={() => {
            setSelection(null);
            void refresh();
          }}
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
}: {
  release: Release;
  values: Settings;
  secrets: Record<string, string>;
  onChange: (key: string, value: string | boolean | number) => void;
  onSecret: (key: string, value: string) => void;
  existing?: Installation;
  references: Record<string, string>;
}) {
  return (
    <>
      {Object.entries(release.manifest.settings).map(([key, definition]) => {
        const locked = !!existing && (definition.secret || definition.reconnect);
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
            ) : definition.type === 'boolean' ? (
              <Input
                type="checkbox"
                checked={values[key] === true}
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
            {locked ? (
              <Muted small>
                Changing this connection requires reconnect support from this service.
              </Muted>
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
  onClose,
  onSaved,
}: {
  release: Release;
  installation?: Installation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { schema } = useWorkspace();
  const retained = installation?.state !== 'uninstalled' ? installation : undefined;
  const upgrade = !!retained && retained.version !== release.manifest.version;
  const [values, setValues] = useState<Settings>(() => ({
    ...Object.fromEntries(
      Object.entries(release.manifest.settings)
        .filter(([, def]) => def.type === 'boolean' && !def.secret)
        .map(([key]) => [key, false]),
    ),
    ...installation?.settings,
  }));
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
        settings: values,
        ...(Object.keys(refs).length ? { secretRefs: refs } : {}),
      };
      const preview = await api.previewExtension(input);
      setPlan({ input, preview, key: crypto.randomUUID() });
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (retained && !upgrade)
        return api.updateExtensionSettings(retained.id, {
          expectedRevision: retained.settingsRevision,
          settings: values,
        });
      if (!plan) throw new Error('Review the installation before approval.');
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
  const updating = !!retained && !upgrade;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`${release.manifest.name} ${updating ? 'settings' : upgrade ? 'upgrade' : 'setup'}`}
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
                <p>
                  People creation: {release.manifest.createPeople.replaceAll('_', ' ')}. When source
                  content is deleted:{' '}
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
              {busy ? 'Working…' : updating ? 'Save settings' : 'Review installation'}
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
