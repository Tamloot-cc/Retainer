import type {
  ExtensionConnection,
  ExtensionInstallation,
  ExtensionManifest,
} from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import type { Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountContext, type AccountState } from '../../accounts/context.js';
import { api, WorkspaceContext } from '../../api/client.js';
import { navigation } from './connect-return.js';
import { connectionError, MemberConnectionPanel } from './connections.js';

const installation = { id: 'installation', state: 'active' } as ExtensionInstallation;
const release = {
  manifest: {
    name: 'tamloot',
    connection: 'member',
    settings: {
      share: {
        type: 'boolean',
        label: 'Share meetings',
        level: 'installation',
        required: true,
        consent: true,
        secret: false,
        reconnect: false,
      },
      days: {
        type: 'number',
        label: 'History days',
        level: 'connection',
        required: true,
        default: 31,
        secret: false,
        reconnect: false,
      },
      apiKey: {
        type: 'string',
        label: 'Tamloot key',
        level: 'connection',
        secret: true,
        reconnect: true,
        required: true,
      },
    },
  } as Pick<ExtensionManifest, 'name' | 'connection' | 'settings'>,
};
const connection: ExtensionConnection = {
  id: 'own',
  installationId: 'installation',
  owner: { type: 'user', id: 'member', name: 'Dana' },
  state: 'active',
  health: 'ok',
  generation: 3,
  settings: { days: 31 },
  settingsRevision: 1,
  secrets: ['apiKey'],
  credential: 'key',
  hasImportedItems: true,
  releaseIncompleteAt: null,
  lastError: null,
  createdAt: '2026-11-13T00:00:00Z',
  connectedAt: '2026-11-13T00:00:00Z',
  disconnectedAt: null,
  lastSuccessfulScanAt: null,
  failedItems: 0,
};
function mount(admin = false) {
  const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
    onChanged = vi.fn().mockResolvedValue(undefined),
    onRuns = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider
        value={
          {
            session: {
              actor: { type: 'user', id: 'member' },
              scopes: admin ? ['admin'] : ['read'],
              workspace: { id: 'workspace' },
            } as Session,
            schema: { objects: [] },
          } as never
        }
      >
        <MemberConnectionPanel
          installation={installation}
          release={release}
          admin={admin}
          onChanged={onChanged}
          onRuns={onRuns}
        />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  return { client, onChanged, onRuns, user: userEvent.setup() };
}
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});
describe('member connection controls', () => {
  it('stages a private key and connects with only member settings, then disconnects without an admin role', async () => {
    let rows: ExtensionConnection[] = [];
    vi.spyOn(api, 'extensionConnections').mockImplementation(async () => ({ connections: rows }));
    const stage = vi.spyOn(api, 'stageExtensionConnectionSecret').mockResolvedValue({
      pendingSecretId: 'pending',
      installationId: 'installation',
      connectionId: 'own',
      expiresAt: '2026-11-13T01:00:00Z',
    });
    const connect = vi.spyOn(api, 'connectExtension').mockImplementation(async () => {
      rows = [{ ...connection, state: 'connecting' }];
      return { id: 'own', state: 'connecting' };
    });
    const disconnect = vi.spyOn(api, 'disconnectExtension').mockImplementation(async () => {
      rows = [];
      return { disconnected: true };
    });
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Connect account' }));
    const dialog = screen.getByRole('form', { name: 'Connect your Tamloot account' });
    expect(within(dialog).queryByLabelText(/Share meetings/)).toBeNull();
    expect(
      (within(dialog).getByLabelText('History days (required)') as HTMLInputElement).value,
    ).toBe('31');
    await user.type(within(dialog).getByLabelText('Tamloot key (required)'), 'fixture-key');
    await user.click(within(dialog).getByRole('button', { name: 'Connect account' }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith('installation', {
        settings: { days: 31 },
        secretRefs: { apiKey: 'pending' },
      }),
    );
    expect(stage).toHaveBeenCalledWith('installation', { name: 'apiKey', value: 'fixture-key' });
    await screen.findByText('Connecting · Ok');
    expect(screen.queryByRole('region', { name: 'Member connections' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Disconnect account' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('installation', 'own'));
    await screen.findByRole('button', { name: 'Connect account' });
  });
  it('shows an admin every owner and lets them disconnect another member', async () => {
    const other = {
      ...connection,
      id: 'other',
      owner: { type: 'user' as const, id: 'eli', name: 'Eli' },
      health: 'needs_reconnect' as const,
    };
    let rows = [connection, other];
    vi.spyOn(api, 'extensionConnections').mockImplementation(async () => ({ connections: rows }));
    const disconnect = vi.spyOn(api, 'disconnectExtension').mockImplementation(async (_id, cid) => {
      rows = rows.map((c) => (c.id === cid ? { ...c, state: 'disconnected' as const } : c));
      return { disconnected: true };
    });
    const { user, onRuns } = mount(true);
    const region = await screen.findByRole('region', { name: 'Member connections' });
    expect(within(region).getByText('Dana')).toBeTruthy();
    expect(within(region).getByText('Eli')).toBeTruthy();
    await user.click(within(region).getByRole('button', { name: 'View runs for Eli' }));
    expect(onRuns).toHaveBeenCalledWith('other');
    await user.click(within(region).getByRole('button', { name: 'Disconnect Eli' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('installation', 'other'));
  });
  it('keeps the reviewed connection generation when another tab changes it during editing', async () => {
    let rows = [connection];
    vi.spyOn(api, 'extensionConnections').mockImplementation(async () => ({ connections: rows }));
    const reconnect = vi
      .spyOn(api, 'reconnectExtension')
      .mockRejectedValue(new Error('Connection generation changed.'));
    const { user, client } = mount();
    await user.click(await screen.findByRole('button', { name: 'Reconnect account' }));
    rows = [{ ...connection, generation: 4 }];
    await client.invalidateQueries({
      queryKey: ['workspace', 'extension-connections', 'installation'],
    });
    const dialog = screen.getByRole('form', { name: 'Reconnect your Tamloot account' });
    await user.click(within(dialog).getByRole('button', { name: 'Reconnect account' }));
    await waitFor(() =>
      expect(reconnect).toHaveBeenCalledWith('installation', 'own', {
        settings: { days: 31 },
        secretRefs: {},
        expectedGeneration: 3,
      }),
    );
    expect(await within(dialog).findByText('Connection generation changed.')).toBeTruthy();
  });
});

const oauthRelease = {
  manifest: {
    ...release.manifest,
    settings: {
      ...release.manifest.settings,
      apiKey: { ...release.manifest.settings.apiKey, required: false },
      verifier: {
        type: 'string',
        label: 'Verifier',
        level: 'connection',
        secret: true,
        generated: true,
        reconnect: false,
      },
    },
    oauth: {
      verifierSetting: 'verifier',
      codeSetting: 'code',
      tokenSetting: 'tokens',
      keySetting: 'apiKey',
      revokeUrl: 'https://provider.example/settings?tab=apps',
    },
    gettingStarted: {
      text: 'Record a meeting in Tamloot to see it here.',
      linkLabel: 'Open Tamloot',
      url: 'https://provider.example/start',
    },
  } as unknown as Pick<
    ExtensionManifest,
    'name' | 'connection' | 'settings' | 'oauth' | 'gettingStarted'
  >,
};
const both = { ...installation, connectionMethods: ['oauth', 'key'] } as ExtensionInstallation;
const oauthConnection: ExtensionConnection = {
  ...connection,
  credential: 'oauth',
  secrets: ['tokens'],
  lastSuccessfulScanAt: '2026-11-14T00:00:00Z',
};
const account = {
  account: { user: { id: 'member', name: 'Dana', email: 'dana@example.test' } },
} as AccountState;
function mountOAuth({
  admin = false,
  inst = both,
  rel = oauthRelease,
  returned,
  signedIn = account,
}: {
  admin?: boolean;
  inst?: ExtensionInstallation;
  rel?: typeof oauthRelease;
  returned?: string;
  signedIn?: AccountState | null;
} = {}) {
  const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
    onChanged = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={client}>
      <AccountContext.Provider value={signedIn}>
        <WorkspaceContext.Provider
          value={
            {
              session: {
                actor: { type: 'user', id: 'member' },
                scopes: admin ? ['admin'] : ['read'],
                workspace: { id: 'workspace' },
              } as Session,
              schema: { objects: [] },
            } as never
          }
        >
          <MemberConnectionPanel
            installation={inst}
            release={rel}
            admin={admin}
            onChanged={onChanged}
            onRuns={vi.fn()}
            returned={returned}
          />
        </WorkspaceContext.Provider>
      </AccountContext.Provider>
    </QueryClientProvider>,
  );
  return { onChanged, user: userEvent.setup() };
}
const rows = (connections: ExtensionConnection[]) =>
  vi.spyOn(api, 'extensionConnections').mockResolvedValue({ connections });
const authorization = {
  authorizationUrl: 'https://provider.example/oauth/start?state=x',
  state: 'v1.workspace.installation.nonce',
  expiresAt: '2026-11-15T00:10:00Z',
};

describe('connecting with OAuth', () => {
  it("keeps today's tab when the server offers no OAuth", async () => {
    rows([]);
    mountOAuth({ inst: { ...installation, connectionMethods: ['key'] } });
    expect(await screen.findByRole('button', { name: 'Connect account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect with Tamloot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use an API key instead' })).toBeNull();
  });
  it('starts with the inline days and the account email, saves the attempt and leaves for the provider', async () => {
    rows([]);
    const authorize = vi
      .spyOn(api, 'authorizeExtensionConnection')
      .mockResolvedValue(authorization);
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    const { user } = mountOAuth();
    const form = await screen.findByRole('form', { name: 'Connect with Tamloot' });
    const days = within(form).getByLabelText('History days (required)') as HTMLInputElement;
    expect(days.value).toBe('31');
    // Secrets never appear beside the button.
    expect(within(form).queryByLabelText(/Tamloot key/)).toBeNull();
    await user.clear(days);
    await user.type(days, '7');
    await user.click(within(form).getByRole('button', { name: 'Connect with Tamloot' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorization.authorizationUrl));
    expect(authorize).toHaveBeenCalledWith('installation', {
      settings: { days: 7 },
      loginHint: 'dana@example.test',
    });
    const saved = JSON.parse(
      sessionStorage.getItem(`retainer:connect:${authorization.state}`) ?? '',
    );
    expect(saved).toMatchObject({ workspaceId: 'workspace', installationId: 'installation' });
  });
  it('sends no login hint in key mode', async () => {
    rows([]);
    const authorize = vi
      .spyOn(api, 'authorizeExtensionConnection')
      .mockResolvedValue(authorization);
    vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    const { user } = mountOAuth({ signedIn: null });
    await user.click(await screen.findByRole('button', { name: 'Connect with Tamloot' }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith('installation', { settings: { days: 31 } }),
    );
  });
  it('says an earlier attempt is still finishing', async () => {
    rows([]);
    vi.spyOn(api, 'authorizeExtensionConnection').mockRejectedValue(
      new RetainerApiError(409, 'cleanup_running', 'Cleanup is running.'),
    );
    const { user } = mountOAuth();
    await user.click(await screen.findByRole('button', { name: 'Connect with Tamloot' }));
    expect(
      await screen.findByText('Retainer is finishing an earlier attempt. Try again in a moment.'),
    ).toBeTruthy();
  });
  it('opens today\'s key form from "Use an API key instead", with the key required', async () => {
    rows([]);
    const { user } = mountOAuth();
    await user.click(await screen.findByRole('button', { name: 'Use an API key instead' }));
    const dialog = screen.getByRole('form', { name: 'Connect your Tamloot account' });
    expect(within(dialog).getByLabelText('Tamloot key (required)')).toBeTruthy();
  });
  it('offers no key form when OAuth is the only method', async () => {
    rows([]);
    mountOAuth({ inst: { ...installation, connectionMethods: ['oauth'] } });
    expect(await screen.findByRole('button', { name: 'Connect with Tamloot' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use an API key instead' })).toBeNull();
  });
  it.each([
    ['declined', "Tamloot isn't connected: the request was declined. You can try again."],
    ['failed', "Tamloot isn't connected: connecting took too long. Try again."],
  ])('shows the %s return notice', async (returned, text) => {
    rows([]);
    mountOAuth({ returned });
    expect(await screen.findByText(text)).toBeTruthy();
  });
  it('says a saved attempt never completed, once, and forgets it', async () => {
    sessionStorage.setItem(
      'retainer:connect:v1.workspace.installation.old',
      JSON.stringify({ workspaceId: 'workspace', installationId: 'installation' }),
    );
    sessionStorage.setItem(
      'retainer:connect:v1.workspace.other.old',
      JSON.stringify({ workspaceId: 'workspace', installationId: 'other' }),
    );
    rows([]);
    mountOAuth();
    expect(await screen.findByText("Tamloot isn't connected. You can try again.")).toBeTruthy();
    expect(sessionStorage.getItem('retainer:connect:v1.workspace.installation.old')).toBeNull();
    expect(sessionStorage.getItem('retainer:connect:v1.workspace.other.old')).not.toBeNull();
  });
  it('forgets a saved attempt without a notice when the connection exists', async () => {
    sessionStorage.setItem(
      'retainer:connect:v1.workspace.installation.done',
      JSON.stringify({ workspaceId: 'workspace', installationId: 'installation' }),
    );
    rows([{ ...oauthConnection, state: 'connecting' }]);
    mountOAuth();
    expect(await screen.findByText('Connecting · Ok')).toBeTruthy();
    await waitFor(() =>
      expect(sessionStorage.getItem('retainer:connect:v1.workspace.installation.done')).toBeNull(),
    );
    expect(screen.queryByText(/isn't connected/)).toBeNull();
  });
  it('shows importing until the first scan finishes, then the getting-started text', async () => {
    const list = rows([
      { ...oauthConnection, lastSuccessfulScanAt: null, hasImportedItems: false },
    ]);
    mountOAuth();
    expect(await screen.findByText('Importing…')).toBeTruthy();
    expect(screen.getByText(/No completed scan yet/)).toBeTruthy();
    expect(
      screen.getByText(
        "Disconnecting stops imports now and keeps imported records in the workspace. Retainer then gives up this workspace's access in Tamloot, retrying for up to a day.",
      ),
    ).toBeTruthy();
    cleanup();
    list.mockResolvedValue({ connections: [{ ...oauthConnection, hasImportedItems: false }] });
    mountOAuth();
    expect(await screen.findByText(/Record a meeting in Tamloot to see it here/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Tamloot' }).getAttribute('href')).toBe(
      'https://provider.example/start',
    );
    cleanup();
    list.mockResolvedValue({ connections: [oauthConnection] });
    mountOAuth();
    expect(await screen.findByText(/Last completed scan:/)).toBeTruthy();
    expect(screen.queryByText(/Record a meeting/)).toBeNull();
  });
  it('shows needs reconnect with its reason and reconnects with the connection and generation', async () => {
    rows([
      {
        ...oauthConnection,
        state: 'needs_reconnect',
        health: 'needs_reconnect',
        lastError: 'provider_unauthorized',
        settings: { days: 14 },
      },
    ]);
    const authorize = vi
      .spyOn(api, 'authorizeExtensionConnection')
      .mockResolvedValue(authorization);
    vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    const { user } = mountOAuth();
    expect(await screen.findByText('Needs reconnect')).toBeTruthy();
    expect(
      screen.getByText(
        "Retainer's access to this Tamloot account ended. Connect again to resume imports.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/If you don't connect again, disconnect/)).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Connect with Tamloot' });
    expect((within(form).getByLabelText('History days (required)') as HTMLInputElement).value).toBe(
      '14',
    );
    await user.click(within(form).getByRole('button', { name: 'Connect with Tamloot' }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith('installation', {
        settings: { days: 14 },
        connectionId: 'own',
        expectedGeneration: 3,
        loginHint: 'dana@example.test',
      }),
    );
    expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeTruthy();
  });
  it('reconnects an active OAuth connection through the same button', async () => {
    rows([oauthConnection]);
    const { user } = mountOAuth();
    expect(screen.queryByRole('form', { name: 'Connect with Tamloot' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Reconnect account' }));
    expect(screen.getByRole('form', { name: 'Connect with Tamloot' })).toBeTruthy();
    // Never today's key form for an OAuth connection.
    expect(screen.queryByRole('form', { name: /Reconnect your Tamloot account/ })).toBeNull();
  });
  it('shows a setup failure with its reason and the connect button', async () => {
    rows([{ ...oauthConnection, state: 'setup_failed', lastError: 'release_backlog' }]);
    mountOAuth();
    expect(
      await screen.findByText(
        "Tamloot couldn't be reached to end an earlier connection. Try again in a few minutes.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect with Tamloot' })).toBeTruthy();
    expect(screen.queryByText('Needs reconnect')).toBeNull();
  });
  it('words each OAuth reason for its state, and keeps key texts', () => {
    const at = (state: ExtensionConnection['state'], credential: 'oauth' | 'key' = 'oauth') => ({
      ...connection,
      state,
      credential,
    });
    expect(connectionError('provider_unauthorized', at('setup_failed'), 'Tamloot')).toBe(
      "Tamloot didn't finish connecting. Try again.",
    );
    expect(connectionError('exchange_interrupted', at('setup_failed'), 'Tamloot')).toBe(
      "Tamloot didn't finish connecting. Try again.",
    );
    expect(connectionError('source_account_changed', at('needs_reconnect'), 'Tamloot')).toBe(
      'You approved a different Tamloot account. Connect again with the first one, or disconnect to switch.',
    );
    expect(connectionError('lost_backlog', at('setup_failed'), 'Tamloot')).toMatch(
      /^Connecting to Tamloot was interrupted too many times\. Disconnect, then connect again\./,
    );
    expect(connectionError('provider_unauthorized', at('needs_reconnect', 'key'), 'Tamloot')).toBe(
      'Your key no longer works. Reconnect with a new key.',
    );
    expect(connectionError('rate_limited', at('setup_failed'), 'Tamloot')).toBe(
      'Needs attention: rate limited',
    );
  });
  it('keeps showing an OAuth connection as OAuth after the server stops offering OAuth', async () => {
    rows([
      {
        ...oauthConnection,
        state: 'needs_reconnect',
        health: 'needs_reconnect',
        lastError: 'provider_unauthorized',
      },
    ]);
    mountOAuth({
      inst: {
        ...installation,
        connectionMethods: ['key'],
        releaseNotice: { connectionId: 'old', at: '2026-11-15T10:00:00Z' },
      },
    });
    expect(await screen.findByText('Needs reconnect')).toBeTruthy();
    expect(
      screen.getByText(
        "Retainer's access to this Tamloot account ended. Connect again to resume imports.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/If you don't connect again, disconnect/)).toBeTruthy();
    expect(
      screen.getByText(/Retainer couldn't confirm it ended its access in Tamloot\./),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Connect with Tamloot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect account' })).toBeTruthy();
  });
  it('offers no connect action when the server offers no method', async () => {
    rows([]);
    mountOAuth({ inst: { ...installation, connectionMethods: [] } });
    expect(await screen.findByText(/Connect your own account/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect with Tamloot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect account' })).toBeNull();
  });
  it('shows the release notice with the revoke link and dismisses it with the exact stamp', async () => {
    rows([]);
    const at = '2026-11-15 10:00:00.123456+00';
    const dismiss = vi.spyOn(api, 'dismissReleaseNotice').mockResolvedValue({ dismissed: true });
    const { user, onChanged } = mountOAuth({
      inst: { ...both, releaseNotice: { connectionId: 'old', at } },
    });
    expect(
      await screen.findByText(/Retainer couldn't confirm it ended its access in Tamloot\./),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Connected apps' }).getAttribute('href')).toBe(
      'https://provider.example/settings?tab=apps',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('installation', 'old', at));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
  it('reloads the notice quietly when a newer incident arrived', async () => {
    rows([]);
    vi.spyOn(api, 'dismissReleaseNotice').mockRejectedValue(
      new RetainerApiError(409, 'notice_changed', 'The notice changed.'),
    );
    const { user, onChanged } = mountOAuth({
      inst: { ...both, releaseNotice: { connectionId: 'old', at: '2026-11-15T10:00:00Z' } },
    });
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByText('The notice changed.')).toBeNull();
  });
  it('gives admins a reason column, including access that may remain', async () => {
    rows([
      {
        ...oauthConnection,
        id: 'eli',
        owner: { type: 'user', id: 'eli', name: 'Eli' },
        state: 'needs_reconnect',
        health: 'needs_reconnect',
        lastError: 'provider_unauthorized',
      },
      {
        ...oauthConnection,
        id: 'noa',
        owner: { type: 'user', id: 'noa', name: 'Noa' },
        state: 'disconnected',
        releaseIncompleteAt: '2026-11-15T10:00:00Z',
      },
    ]);
    mountOAuth({ admin: true });
    const region = await screen.findByRole('region', { name: 'Member connections' });
    expect(within(region).getByRole('columnheader', { name: 'Reason' })).toBeTruthy();
    expect(
      within(region).getByText(
        "Retainer's access to this Tamloot account ended. Connect again to resume imports.",
      ),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        'Tamloot access may remain. The member can revoke Retainer in Tamloot.',
      ),
    ).toBeTruthy();
  });
  it('adds no reason column without OAuth', async () => {
    rows([{ ...connection, owner: { type: 'user', id: 'eli', name: 'Eli' } }]);
    mountOAuth({ admin: true, inst: installation });
    const region = await screen.findByRole('region', { name: 'Member connections' });
    expect(within(region).queryByRole('columnheader', { name: 'Reason' })).toBeNull();
  });
});
