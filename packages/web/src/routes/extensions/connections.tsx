import type {
  ExtensionConnection,
  ExtensionInstallation,
  ExtensionManifest,
} from '@retainer/extension';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { Button, Muted, Notice, Panel, Row, Stack } from '../../ui/index.js';
import { QueryError } from '../state.js';
import { stateLabel as label } from './model.js';
import { SettingFields } from './setting-fields.js';

type Release = { manifest: Pick<ExtensionManifest, 'name' | 'settings'> };
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'No completed scan yet';
function connectionError(code: string) {
  if (code === 'provider_unauthorized')
    return 'Your key no longer works. Reconnect with a new key.';
  if (code === 'source_account_changed')
    return 'This key belongs to a different account. Disconnect before connecting that account.';
  if (code === 'source_account_in_use')
    return 'This account is already connected in this workspace.';
  return `Needs attention: ${code.replaceAll('_', ' ')}`;
}
export function MemberConnectionPanel({
  installation,
  release,
  admin,
  onChanged,
  onRuns,
}: {
  installation: ExtensionInstallation;
  release: Release;
  admin: boolean;
  onChanged: () => Promise<unknown>;
  onRuns: (connection: string) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const key = [session.workspace.id, 'extension-connections', installation.id];
  const connections = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.extensionConnections(installation.id, signal),
    refetchInterval: (query) =>
      query.state.data?.connections.some((c) => c.state === 'connecting') ? 3000 : 15000,
  });
  const [form, setForm] = useState<{ connection?: ExtensionConnection } | null>(null);
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: key }), onChanged()]);
  };
  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnectExtension(installation.id, id),
    onSuccess: refresh,
  });
  const own = connections.data?.connections.find(
    (c) => c.owner.id === session.actor.id && c.state !== 'disconnected',
  );
  const human = session.actor.type === 'user',
    enabled = installation.state === 'active';
  return (
    <Stack>
      <section
        aria-label={`Your ${label(release.manifest.name)} connection`}
        className="flex flex-col gap-3"
      >
        <h3 className="font-medium">Your {label(release.manifest.name)} connection</h3>
        {connections.error ? (
          <QueryError error={connections.error} retry={() => void connections.refetch()} />
        ) : null}
        {disconnect.error ? <Notice>{disconnect.error.message}</Notice> : null}
        {!connections.data && !connections.error ? (
          <Muted>Loading your connection…</Muted>
        ) : own ? (
          <>
            <p>
              {label(own.state)} · {label(own.health)}
            </p>
            <Muted>
              Last completed scan: {date(own.lastSuccessfulScanAt)}. Failed imports:{' '}
              {own.failedItems}.
            </Muted>
            {own.lastError ? <Notice>{connectionError(own.lastError)}</Notice> : null}
            <Row>
              {human ? (
                <Button disabled={!enabled} onClick={() => setForm({ connection: own })}>
                  Reconnect account
                </Button>
              ) : null}
              {human ? (
                <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(own.id)}>
                  Disconnect account
                </Button>
              ) : null}
              <Button onClick={() => onRuns(own.id)}>View your runs</Button>
            </Row>
          </>
        ) : connections.data ? (
          <>
            <Muted>
              {human
                ? 'Connect your own account to share its data with this workspace.'
                : 'A person must connect their account. Sign in with a user key or a person’s session.'}
            </Muted>
            {human ? (
              <Button disabled={!enabled} onClick={() => setForm({})}>
                Connect account
              </Button>
            ) : null}
          </>
        ) : null}
        {!enabled ? (
          <Muted>
            {['installing', 'upgrading'].includes(installation.state)
              ? 'Workspace setup is still running. Connect after it finishes.'
              : 'An admin must enable this extension before you connect.'}
          </Muted>
        ) : null}
        <Muted small>
          Disconnecting keeps imported records in the workspace. A completed scan can still have
          pending or failed imports.
        </Muted>
      </section>
      {form ? (
        <ConnectionForm
          installation={installation}
          release={release}
          connection={form.connection}
          onClose={() => setForm(null)}
          onSaved={refresh}
        />
      ) : null}
      {admin && connections.data?.connections.length ? (
        <section aria-label="Member connections">
          <h3 className="mb-2 font-medium">Member connections</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {[
                    'Owner',
                    'Status',
                    'Health',
                    'Last completed scan',
                    'Failed imports',
                    'Actions',
                  ].map((title) => (
                    <th className="p-2" scope="col" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {connections.data.connections.map((c) => (
                  <tr key={c.id}>
                    <td className="p-2">{c.owner.name ?? c.owner.id}</td>
                    <td className="p-2">{label(c.state)}</td>
                    <td className="p-2">{label(c.health)}</td>
                    <td className="p-2">{date(c.lastSuccessfulScanAt)}</td>
                    <td className="p-2">{c.failedItems}</td>
                    <td className="p-2">
                      <Row>
                        <Button onClick={() => onRuns(c.id)}>
                          View runs for {c.owner.name ?? c.owner.id}
                        </Button>
                        {c.state !== 'disconnected' ? (
                          <Button
                            disabled={disconnect.isPending}
                            onClick={() => disconnect.mutate(c.id)}
                          >
                            Disconnect {c.owner.name ?? c.owner.id}
                          </Button>
                        ) : null}
                      </Row>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Stack>
  );
}
function ConnectionForm({
  installation,
  release,
  connection,
  onClose,
  onSaved,
}: {
  installation: ExtensionInstallation;
  release: Release;
  connection?: ExtensionConnection;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string | boolean | number>>(() =>
    Object.fromEntries(
      Object.entries(release.manifest.settings).flatMap(([key, definition]) => {
        if (definition.level !== 'connection' || definition.secret) return [];
        const value =
          connection?.settings[key] ??
          definition.default ??
          (definition.type === 'boolean' ? false : undefined);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({}),
    [refs, setRefs] = useState<Record<string, string>>({}),
    [draft, setDraft] = useState(connection?.id);
  const save = useMutation({
    mutationFn: async () => {
      const references = { ...refs };
      let cid = draft;
      for (const [name, value] of Object.entries(secrets)) {
        if (!value) continue;
        const staged = await api.stageExtensionConnectionSecret(installation.id, {
          ...(cid ? { connectionId: cid } : {}),
          name,
          value,
        });
        cid = staged.connectionId;
        setDraft(cid);
        references[name] = staged.pendingSecretId;
        setRefs((previous) => ({ ...previous, [name]: staged.pendingSecretId }));
        setSecrets((previous) => ({ ...previous, [name]: '' }));
      }
      const input = { settings: values, secretRefs: references };
      return connection
        ? api.reconnectExtension(installation.id, connection.id, {
            ...input,
            expectedGeneration: connection.generation,
          })
        : api.connectExtension(installation.id, input);
    },
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  const title = `${connection ? 'Reconnect' : 'Connect'} your ${label(release.manifest.name)} account`;
  return (
    <Panel title={title}>
      <form
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          <Muted>Data synced from this account is shared with the workspace.</Muted>
          {save.error ? <Notice error>{save.error.message}</Notice> : null}
          <SettingFields
            release={release}
            values={values}
            secrets={secrets}
            references={refs}
            connectionSecrets={connection?.secrets}
            level="connection"
            providedLabel="Provided for connection"
            onChange={(key, value) => setValues((previous) => ({ ...previous, [key]: value }))}
            onSecret={(key, value) => setSecrets((previous) => ({ ...previous, [key]: value }))}
          />
          <Row>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending
                ? 'Connecting…'
                : connection
                  ? 'Reconnect account'
                  : 'Connect account'}
            </Button>
            <Button disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
          </Row>
        </Stack>
      </form>
    </Panel>
  );
}
