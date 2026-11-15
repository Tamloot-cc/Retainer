import type {
  ExtensionConnection,
  ExtensionInstallation,
  ExtensionManifest,
} from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAccount } from '../../accounts/context.js';
import { api, useWorkspace } from '../../api/client.js';
import { Button, Muted, Notice, Panel, Row, Stack } from '../../ui/index.js';
import { QueryError } from '../state.js';
import {
  forgetAttempt,
  loginHint,
  navigation,
  saveAttempt,
  savedAttempts,
} from './connect-return.js';
import { stateLabel as label } from './model.js';
import { SettingFields } from './setting-fields.js';

type Release = {
  manifest: Pick<ExtensionManifest, 'name' | 'settings'> &
    Partial<Pick<ExtensionManifest, 'oauth' | 'gettingStarted'>>;
};
type Values = Record<string, string | boolean | number>;
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'No completed scan yet';
/** An OAuth connection that imports nothing until the member connects again. */
const failing = (c: ExtensionConnection) =>
  c.state === 'setup_failed' || c.state === 'needs_reconnect' || c.health === 'needs_reconnect';
/** The reason for an OAuth connection's error (Tamloot connect spec 6.2), else today's text. */
function oauthError(code: string, c: ExtensionConnection, provider: string): string | null {
  const setupFailed = c.state === 'setup_failed';
  if (code === 'provider_unauthorized')
    return setupFailed
      ? `${provider} didn't finish connecting. Try again.`
      : `Retainer's access to this ${provider} account ended. Connect again to resume imports.`;
  if (code === 'source_account_changed')
    return `You approved a different ${provider} account. Connect again with the first one, or disconnect to switch.`;
  if (!setupFailed) return null;
  if (code === 'release_backlog')
    return `${provider} couldn't be reached to end an earlier connection. Try again in a few minutes.`;
  if (code === 'exchange_interrupted') return `${provider} didn't finish connecting. Try again.`;
  if (code === 'lost_backlog')
    return `Connecting to ${provider} was interrupted too many times. Disconnect, then connect again. To end any access left behind, revoke Retainer in ${provider}: Settings → Connected apps. That disconnects every Retainer workspace that uses this ${provider} account.`;
  return null;
}
/** What went wrong with a connection, for its credential: OAuth reasons when `provider` is given. */
export function connectionError(code: string, c?: ExtensionConnection, provider?: string) {
  if (c?.credential === 'oauth' && provider) {
    const text = oauthError(code, c, provider);
    if (text) return text;
  }
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
  returned,
}: {
  installation: ExtensionInstallation;
  release: Release;
  admin: boolean;
  onChanged: () => Promise<unknown>;
  onRuns: (connection: string) => void;
  /** `?connect=` after an OAuth return: `declined` or `failed`. */
  returned?: string | undefined;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const oauth = !!release.manifest.oauth && !!installation.connectionMethods?.includes('oauth'),
    keyMethod = !oauth || installation.connectionMethods?.includes('key'),
    provider = label(release.manifest.name);
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
  const [reconnecting, setReconnecting] = useState(false);
  const [returnNotice, setReturnNotice] = useState<string | null>(() =>
    !oauth
      ? null
      : returned === 'declined'
        ? `${provider} isn't connected: the request was declined. You can try again.`
        : returned === 'failed'
          ? `${provider} isn't connected: connecting took too long. Try again.`
          : null,
  );
  // A saved attempt with no connection and no result never came back (spec 6.2).
  const checked = useRef(false);
  useEffect(() => {
    if (!oauth || !connections.data || checked.current) return;
    checked.current = true;
    const saved = savedAttempts(session.workspace.id, installation.id);
    for (const state of saved) forgetAttempt(state);
    if (saved.length && !own && !returned)
      setReturnNotice(`${provider} isn't connected. You can try again.`);
  }, [oauth, connections.data, own, returned, provider, session.workspace.id, installation.id]);
  const ownOAuth = oauth && own?.credential === 'oauth';
  return (
    <Stack>
      <section
        aria-label={`Your ${label(release.manifest.name)} connection`}
        className="flex flex-col gap-3"
      >
        <h3 className="font-medium">Your {label(release.manifest.name)} connection</h3>
        {returnNotice ? (
          <Notice onDismiss={() => setReturnNotice(null)}>{returnNotice}</Notice>
        ) : null}
        {oauth && installation.releaseNotice ? (
          <ReleaseNotice
            key={installation.releaseNotice.at}
            installation={installation}
            notice={installation.releaseNotice}
            provider={provider}
            revokeUrl={release.manifest.oauth?.revokeUrl}
            onChanged={onChanged}
          />
        ) : null}
        {connections.error ? (
          <QueryError error={connections.error} retry={() => void connections.refetch()} />
        ) : null}
        {disconnect.error ? <Notice>{disconnect.error.message}</Notice> : null}
        {!connections.data && !connections.error ? (
          <Muted>Loading your connection…</Muted>
        ) : ownOAuth && own ? (
          <OAuthConnection
            connection={own}
            installation={installation}
            release={release}
            provider={provider}
            human={human}
            enabled={enabled}
            reconnecting={reconnecting}
            onReconnect={() => setReconnecting((open) => !open)}
            onDisconnect={() => disconnect.mutate(own.id)}
            disconnecting={disconnect.isPending}
            onRuns={() => onRuns(own.id)}
          />
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
            {human && oauth ? (
              <OAuthStart
                installation={installation}
                release={release}
                provider={provider}
                disabled={!enabled}
              />
            ) : null}
            {human && keyMethod ? (
              oauth ? (
                <div>
                  <Button variant="ghost" disabled={!enabled} onClick={() => setForm({})}>
                    Use an API key instead
                  </Button>
                </div>
              ) : (
                <Button disabled={!enabled} onClick={() => setForm({})}>
                  Connect account
                </Button>
              )
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
          {ownOAuth
            ? `Disconnecting stops imports now and keeps imported records in the workspace. Retainer then gives up this workspace's access in ${provider}, retrying for up to a day.`
            : 'Disconnecting keeps imported records in the workspace. A completed scan can still have pending or failed imports.'}
        </Muted>
      </section>
      {form ? (
        <ConnectionForm
          installation={installation}
          release={oauth ? keyRequired(release) : release}
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
                    ...(oauth ? ['Reason'] : []),
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
                    {oauth ? (
                      <td className="p-2">
                        {c.releaseIncompleteAt
                          ? `${provider} access may remain. The member can revoke Retainer in ${provider}.`
                          : c.lastError
                            ? connectionError(c.lastError, c, provider)
                            : ''}
                      </td>
                    ) : null}
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
  const [values, setValues] = useState<Values>(() => connectionValues(release, connection));
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
/** A connection's non-secret settings: its current values, else the manifest's defaults. */
function connectionValues(release: Release, connection?: ExtensionConnection): Values {
  return Object.fromEntries(
    Object.entries(release.manifest.settings).flatMap(([key, definition]) => {
      if (definition.level !== 'connection' || definition.secret) return [];
      const value =
        connection?.settings[key] ??
        definition.default ??
        (definition.type === 'boolean' ? false : undefined);
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
/** With OAuth no connection secret is required in the manifest; the key form still needs its key. */
function keyRequired(release: Release): Release {
  const key = release.manifest.oauth?.keySetting;
  const definition = key ? release.manifest.settings[key] : undefined;
  if (!key || !definition) return release;
  return {
    manifest: {
      ...release.manifest,
      settings: { ...release.manifest.settings, [key]: { ...definition, required: true } },
    },
  };
}
const CLEANUP_RUNNING = 'Retainer is finishing an earlier attempt. Try again in a moment.';
/**
 * The non-secret connection settings and **Connect with <name>**: starts the
 * provider's authorization and leaves for it (Tamloot connect spec 6.1).
 */
function OAuthStart({
  installation,
  release,
  provider,
  connection,
  disabled,
}: {
  installation: ExtensionInstallation;
  release: Release;
  provider: string;
  connection?: ExtensionConnection;
  disabled: boolean;
}) {
  const { session } = useWorkspace();
  const email = useAccount()?.account.user.email;
  const [values, setValues] = useState<Values>(() => connectionValues(release, connection));
  const start = useMutation({
    mutationFn: async () => {
      // Key mode has no account, so no hint.
      const hint = loginHint(email);
      const started = await api.authorizeExtensionConnection(installation.id, {
        settings: values,
        ...(connection
          ? { connectionId: connection.id, expectedGeneration: connection.generation }
          : {}),
        ...(hint ? { loginHint: hint } : {}),
      });
      saveAttempt(started.state, {
        workspaceId: session.workspace.id,
        installationId: installation.id,
        returnPath: window.location.pathname,
        startedAt: new Date().toISOString(),
      });
      navigation.assign(started.authorizationUrl);
      // Stay pending while the browser leaves.
      await new Promise(() => {});
    },
  });
  const name = `Connect with ${provider}`;
  return (
    <form
      aria-label={name}
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
    >
      <Stack>
        {start.error ? (
          <Notice error>
            {start.error instanceof RetainerApiError && start.error.code === 'cleanup_running'
              ? CLEANUP_RUNNING
              : start.error.message}
          </Notice>
        ) : null}
        <SettingFields
          release={release}
          values={values}
          secrets={{}}
          references={{}}
          level="connection"
          omitSecrets
          onChange={(key, value) => setValues((previous) => ({ ...previous, [key]: value }))}
          onSecret={() => {}}
        />
        <div>
          <Button type="submit" variant="primary" disabled={disabled || start.isPending}>
            {name}
          </Button>
        </div>
      </Stack>
    </form>
  );
}
/** The member's own OAuth connection, by state (Tamloot connect spec 6.2). */
function OAuthConnection({
  connection: c,
  installation,
  release,
  provider,
  human,
  enabled,
  reconnecting,
  onReconnect,
  onDisconnect,
  disconnecting,
  onRuns,
}: {
  connection: ExtensionConnection;
  installation: ExtensionInstallation;
  release: Release;
  provider: string;
  human: boolean;
  enabled: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  onRuns: () => void;
}) {
  const broken = failing(c);
  const started = release.manifest.gettingStarted;
  const scanLine = (
    <Muted>
      Last completed scan: {date(c.lastSuccessfulScanAt)}. Failed imports: {c.failedItems}.
    </Muted>
  );
  return (
    <>
      {c.state === 'setup_failed' ? null : broken ? (
        <p>Needs reconnect</p>
      ) : c.state === 'active' && !c.lastSuccessfulScanAt ? (
        <>
          <p>Importing…</p>
          {scanLine}
        </>
      ) : c.state === 'active' && !c.hasImportedItems && started ? (
        <>
          <p>
            {label(c.state)} · {label(c.health)}
          </p>
          <Muted>
            {started.text}{' '}
            <a href={started.url} target="_blank" rel="noopener noreferrer" className="underline">
              {started.linkLabel}
            </a>
          </Muted>
        </>
      ) : (
        <>
          <p>
            {label(c.state)} · {label(c.health)}
          </p>
          {scanLine}
        </>
      )}
      {c.lastError ? <Notice>{connectionError(c.lastError, c, provider)}</Notice> : null}
      {broken ? (
        <Muted small>
          If you don't connect again, disconnect: imports stay stopped and Retainer gives up its
          access in {provider}, retrying for up to a day. Revoking Retainer in {provider} always
          ends it.
        </Muted>
      ) : null}
      {human && (broken || reconnecting) ? (
        <OAuthStart
          installation={installation}
          release={release}
          provider={provider}
          connection={c}
          disabled={!enabled}
        />
      ) : null}
      <Row>
        {human && !broken ? (
          <Button disabled={!enabled} onClick={onReconnect}>
            Reconnect account
          </Button>
        ) : null}
        {human ? (
          <Button disabled={disconnecting} onClick={onDisconnect}>
            Disconnect account
          </Button>
        ) : null}
        <Button onClick={onRuns}>View your runs</Button>
      </Row>
    </>
  );
}
/** Retainer couldn't confirm it gave up its access; shown until the member dismisses it. */
function ReleaseNotice({
  installation,
  notice,
  provider,
  revokeUrl,
  onChanged,
}: {
  installation: ExtensionInstallation;
  notice: { connectionId: string; at: string };
  provider: string;
  revokeUrl: string | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const dismiss = useMutation({
    // `at` goes back exactly as read: never through Date (spec 4.7).
    mutationFn: () => api.dismissReleaseNotice(installation.id, notice.connectionId, notice.at),
    onSuccess: onChanged,
    onError: (error) => {
      // A newer incident arrived: show it instead.
      if (error instanceof RetainerApiError && error.code === 'notice_changed') void onChanged();
    },
  });
  const changed =
    dismiss.error instanceof RetainerApiError && dismiss.error.code === 'notice_changed';
  return (
    <div className="flex flex-col gap-2">
      <Notice error>
        Retainer couldn't confirm it ended its access in {provider}. To be sure, revoke Retainer in{' '}
        {provider}: Settings → Connected apps. That disconnects every Retainer workspace that uses
        this {provider} account.
      </Notice>
      {dismiss.error && !changed ? <Notice error>{dismiss.error.message}</Notice> : null}
      <Row>
        {revokeUrl ? (
          <Button asChild>
            <a href={revokeUrl} target="_blank" rel="noopener noreferrer">
              Open Connected apps
            </a>
          </Button>
        ) : null}
        <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          Dismiss
        </Button>
      </Row>
    </div>
  );
}
