import type {
  ExtensionConnection,
  ExtensionInstallation,
  ExtensionManifest,
} from '@retainer/extension';
import type { Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { MemberConnectionPanel } from './connections.js';

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
afterEach(() => vi.restoreAllMocks());
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
