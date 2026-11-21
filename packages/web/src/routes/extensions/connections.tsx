import type {
  ExtensionConnection,
  ExtensionInstallation,
  ExtensionManifest,
} from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, KeyRound, UsersRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useAccount } from '../../accounts/context.js';
import { api, useWorkspace } from '../../api/client.js';
import { Badge, Button, Muted, Notice, Row, Stack } from '../../ui/index.js';
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
import { ExtensionCard, ExtensionFacts } from './surface.js';

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
  // The manifest decides how connections and notices look; the offered
  // methods only decide which connect actions are shown (spec 4.8, 6.2).
  const gmail = release.manifest.name === 'gmail';
  const oauthRelease = !!release.manifest.oauth,
    oauth = oauthRelease && !!installation.connectionMethods?.includes('oauth'),
    keyMethod =
      !gmail &&
      (installation.connectionMethods
        ? installation.connectionMethods.includes('key')
        : !oauthRelease),
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
    !oauthRelease
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
    if (!oauthRelease || !connections.data || checked.current) return;
    checked.current = true;
    const saved = savedAttempts(session.workspace.id, installation.id);
    for (const state of saved) forgetAttempt(state);
    if (saved.length && !own && !returned)
      setReturnNotice(`${provider} isn't connected. You can try again.`);
  }, [
    oauthRelease,
    connections.data,
    own,
    returned,
    provider,
    session.workspace.id,
    installation.id,
  ]);
  const ownOAuth = oauthRelease && own?.credential === 'oauth';
  // OAuth errors and incomplete revocations can outlive an offered OAuth method.
  const showOAuthReasons =
    oauth ||
    (oauthRelease && !!connections.data?.connections.some((c) => c.credential === 'oauth'));
  const members = admin ? connections.data?.connections.filter((c) => c.id !== own?.id) : undefined;
  return (
    <Stack>
      <div className="max-w-2xl">
        <ExtensionCard
          title={`Your ${provider} connection`}
          icon={Cable}
          actions={
            own && !ownOAuth ? (
              <>
                <Button onClick={() => onRuns(own.id)}>View your runs</Button>
                {human && keyMethod ? (
                  <Button disabled={!enabled} onClick={() => setForm({ connection: own })}>
                    Reconnect account
                  </Button>
                ) : null}
                {human ? (
                  <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(own.id)}>
                    Disconnect account
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
        >
          {returnNotice ? (
            <Notice onDismiss={() => setReturnNotice(null)}>{returnNotice}</Notice>
          ) : null}
          {oauthRelease && installation.releaseNotice ? (
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
          {disconnect.error ? <Notice error>{disconnect.error.message}</Notice> : null}
          {!connections.data && !connections.error ? (
            <Muted>Loading your connection…</Muted>
          ) : ownOAuth && own ? (
            <OAuthConnection
              connection={own}
              installation={installation}
              release={release}
              provider={provider}
              human={human}
              available={oauth}
              enabled={enabled}
              reconnecting={reconnecting}
              onReconnect={() => setReconnecting((open) => !open)}
              onDisconnect={() => disconnect.mutate(own.id)}
              disconnecting={disconnect.isPending}
              onRuns={() => onRuns(own.id)}
            />
          ) : own ? (
            <>
              {gmail && typeof own.settings.gmailAddress === 'string' ? (
                <p className="text-base font-semibold">{own.settings.gmailAddress}</p>
              ) : own.owner.name ? (
                <p className="text-base font-semibold">{own.owner.name}</p>
              ) : null}
              <ConnectionBadges connection={own} />
              <ConnectionScan connection={own} />
              {own.lastError ? (
                <Notice>
                  {gmail && own.lastError === 'provider_unauthorized'
                    ? 'Gmail access ended. Disconnect this account and connect it again.'
                    : connectionError(own.lastError)}
                </Notice>
              ) : null}
            </>
          ) : connections.data ? (
            <>
              <Muted>
                {human
                  ? 'Connect your own account to share its data with this workspace.'
                  : 'A person must connect their account. Sign in with a user key or a person’s session.'}
              </Muted>
              {human && gmail ? (
                <GmailAuthorization
                  installation={installation}
                  onChanged={refresh}
                  enabled={enabled}
                />
              ) : null}
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
          {own ? (
            <Muted small>
              {gmail
                ? 'Disconnecting stops future Gmail imports. Previously imported messages remain in this workspace until removed.'
                : ownOAuth
                  ? `Disconnecting stops imports now and keeps imported records in the workspace. Retainer then gives up this workspace's access in ${provider}, retrying for up to a day.`
                  : 'Disconnecting keeps imported records in the workspace. A completed scan can still have pending or failed imports.'}
            </Muted>
          ) : null}
        </ExtensionCard>
      </div>
      {form ? (
        <ConnectionForm
          installation={installation}
          release={oauthRelease ? keyRequired(release) : release}
          connection={form.connection}
          onClose={() => setForm(null)}
          onSaved={refresh}
        />
      ) : null}
      {members?.length ? (
        <ExtensionCard title="Member connections" icon={UsersRound}>
          <ul aria-label="Other member connections" className="@container space-y-2">
            {members.map((c) => {
              const owner = c.owner.name ?? c.owner.id;
              const reason = c.releaseIncompleteAt
                ? `${provider} access may remain. The member can revoke Retainer in ${provider}.`
                : c.lastError
                  ? connectionError(c.lastError, c, provider)
                  : null;
              return (
                <li key={c.id} className="space-y-3 rounded-md border border-border px-3 py-3">
                  <div className="grid gap-3 @min-[40rem]:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_auto] @min-[40rem]:items-center">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-semibold">{owner}</p>
                      <ConnectionBadges connection={c} />
                    </div>
                    <ConnectionScan connection={c} />
                    <Row>
                      <Button
                        size="small"
                        className="min-h-11 @min-[40rem]:min-h-8"
                        aria-label={`View runs for ${owner}`}
                        onClick={() => onRuns(c.id)}
                      >
                        View runs
                      </Button>
                      {c.state !== 'disconnected' ? (
                        <Button
                          size="small"
                          className="min-h-11 @min-[40rem]:min-h-8"
                          aria-label={`Disconnect ${owner}`}
                          disabled={disconnect.isPending}
                          onClick={() => disconnect.mutate(c.id)}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </Row>
                  </div>
                  {showOAuthReasons && reason ? <Notice warning>{reason}</Notice> : null}
                </li>
              );
            })}
          </ul>
        </ExtensionCard>
      ) : null}
    </Stack>
  );
}

function ConnectionBadges({ connection: { state, health } }: { connection: ExtensionConnection }) {
  return (
    <Row>
      <Badge tone={state === 'active' ? 'success' : 'neutral'}>{label(state)}</Badge>
      {health !== 'ok' && health !== state ? <Badge tone="pending">{label(health)}</Badge> : null}
    </Row>
  );
}

function ConnectionScan({ connection }: { connection: ExtensionConnection }) {
  return (
    <ExtensionFacts
      items={[
        ['Last completed scan', date(connection.lastSuccessfulScanAt)],
        ['Failed imports', connection.failedItems],
      ]}
    />
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
    <ExtensionCard title={title} icon={KeyRound}>
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
    </ExtensionCard>
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
/** Explicit workspace-sharing consent before opening the read-only Google grant. */
function GmailAuthorization({
  installation,
  onChanged,
  enabled,
}: {
  installation: ExtensionInstallation;
  onChanged: () => Promise<unknown>;
  enabled: boolean;
}) {
  const id = useId();
  const [pendingMessage, setPendingMessage] = useState('');
  const days = Number(installation.settings.historyDays);
  const start = useMutation({ mutationFn: () => api.authorizeGmail(installation.id, days) });
  const finish = useMutation({
    mutationFn: (attemptId: string) => api.finishGmailAuthorization(installation.id, attemptId),
    onSuccess: async (result) => {
      if ('pending' in result) setPendingMessage('Gmail authorization is still pending.');
      else await onChanged();
    },
  });
  if (start.data)
    return (
      <Stack>
        <a
          className="underline"
          href={start.data.connectLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Authorize Gmail (opens a new tab)
        </a>
        <Row>
          <Button
            type="button"
            disabled={!enabled || finish.isPending}
            onClick={() => finish.mutate(start.data.attemptId)}
          >
            Finish connecting Gmail
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              start.reset();
              finish.reset();
              setPendingMessage('');
            }}
          >
            Start over
          </Button>
        </Row>
        <p role="status">{pendingMessage}</p>
        {finish.error ? <Notice error>{finish.error.message}</Notice> : null}
      </Stack>
    );
  return (
    <form
      aria-label="Connect Gmail"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
      className="flex flex-col items-start gap-3"
    >
      <p id={`${id}-description`} className="text-sm">
        {days === 0
          ? 'This connection starts with new mail.'
          : `This connection starts with up to ${days} days of email history.`}{' '}
        Qualifying message text is shared with workspace members and agents that can read
        Conversations. History for newly added addresses follows the workspace limit at the time
        they are added.
      </p>
      <p className="text-sm">
        Retainer connects to Gmail through Nango, a third-party service that stores your Google
        sign-in and keeps it current, so Google may show Nango's name when you approve access.
        Retainer never receives your Google password.
      </p>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={id}
          name="shareGmail"
          required
          aria-describedby={`${id}-description`}
        />
        <label htmlFor={id}>I agree to share qualifying Gmail messages</label>
      </div>
      <Button type="submit" disabled={!enabled || start.isPending}>
        Connect Gmail
      </Button>
      {start.error ? <Notice error>{start.error.message}</Notice> : null}
    </form>
  );
}

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
  available,
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
  /** Whether OAuth is available on this server now; the connection may outlive it. */
  available: boolean;
  enabled: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  onRuns: () => void;
}) {
  const broken = failing(c);
  const started = release.manifest.gettingStarted;
  const scanLine = <ConnectionScan connection={c} />;
  return (
    <>
      {c.state === 'setup_failed' ? null : broken ? (
        <Badge tone="pending">Needs reconnect</Badge>
      ) : c.state === 'active' && !c.lastSuccessfulScanAt ? (
        <>
          <Badge tone="pending">Importing…</Badge>
          {scanLine}
        </>
      ) : c.state === 'active' && !c.hasImportedItems && started ? (
        <>
          <ConnectionBadges connection={c} />
          <Muted>
            {started.text}{' '}
            <a href={started.url} target="_blank" rel="noopener noreferrer" className="underline">
              {started.linkLabel}
            </a>
          </Muted>
        </>
      ) : (
        <>
          <ConnectionBadges connection={c} />
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
      {human && available && (broken || reconnecting) ? (
        <OAuthStart
          installation={installation}
          release={release}
          provider={provider}
          connection={c}
          disabled={!enabled}
        />
      ) : null}
      <Row>
        {human && available && !broken ? (
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
