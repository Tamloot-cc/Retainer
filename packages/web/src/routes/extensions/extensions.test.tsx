import type { SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { ExtensionPage, InstallationCredentials, SourceSyncStatus } from './detail.js';
import { ExtensionsPage } from './list.js';
import { ExtensionSetup } from './setup.js';
import { router } from './test-router.js';

vi.mock('@tanstack/react-router', async (original) =>
  (await import('./test-router.js')).mockRouter(original),
);

type Release = Awaited<ReturnType<typeof api.extensionCatalog>>['releases'][number];
const release: Release = {
  digest: 'a'.repeat(64),
  actorCeiling: 'integration',
  manifest: {
    manifestVersion: 1,
    universalId: 'e0548bb1-47fd-4de8-8edc-759e26a61e36',
    name: 'Fixture',
    version: '1.0.0',
    description: 'Connect the fixture service.',
    packageDigest: 'b'.repeat(64),
    serverVersions: ['0.1.0'],
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    schema: [],
    views: [],
    functions: [],
    settings: {
      enabled: {
        type: 'boolean',
        label: 'Enabled',
        required: true,
        secret: false,
        reconnect: false,
      },
      apiKey: { type: 'string', label: 'API key', secret: true, required: true, reconnect: true },
    },
  },
};
const preview: Awaited<ReturnType<typeof api.previewExtension>> = {
  planDigest: 'c'.repeat(64),
  schemaVersion: 1,
  generation: 0,
  releaseDigest: release.digest,
  operations: [],
  views: [],
  grants: { actor: 'integration', scopes: ['read', 'write'], uses: [] },
  warnings: ['Runtime activation is unavailable.'],
};
function mount(element: React.ReactNode, admin = true) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'admin' },
            scopes: admin ? ['admin'] : ['read'],
            workspace: { id: 'workspace' },
          } as Session,
          schema: { objects: [] } as unknown as SchemaDescription,
        }}
      >
        {element}
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  router.reset();
});
describe('extension pages and human approval', () => {
  it('offers the newest numeric version once while retaining older installed release metadata', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({
      releases: ['1.0.1', '1.0.10', '1.0.2'].map((version) => ({
        ...release,
        manifest: { ...release.manifest, version },
      })),
    });
    vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [] });
    mount(<ExtensionsPage />);
    expect(await screen.findByText('1.0.10')).toBeTruthy();
    expect(screen.queryByText('1.0.1')).toBeNull();
    expect(screen.queryByText('1.0.2')).toBeNull();
    const setup = screen.getAllByRole('link', { name: 'Set up Fixture' });
    expect(setup).toHaveLength(1);
    expect(setup[0]?.getAttribute('href')).toBe(`/extensions/new/${release.manifest.universalId}`);
  });
  it('shows successful enumeration separately from pending and failed note imports', async () => {
    vi.spyOn(api, 'sourceSyncStatus').mockResolvedValue({
      lastSuccessfulScanAt: '2026-11-11T08:00:00Z',
      activeScan: null,
      pendingItems: 4,
      failedItems: 2,
    });
    mount(<SourceSyncStatus installationId="installation" />);
    expect(await screen.findByText(/Last successful scan:/)).toBeTruthy();
    expect(screen.getByText('4 pending imports · 2 failed imports')).toBeTruthy();
    expect(
      screen.getByText(/A completed scan can still have pending or failed imports/),
    ).toBeTruthy();
  });
  it('defaults contact creation safely and makes sharing consent explicit before review', async () => {
    const choices = {
      ...release,
      manifest: {
        ...release.manifest,
        settings: {
          share: {
            type: 'boolean' as const,
            label: 'Share accessible notes',
            description: 'Everyone in this Retainer workspace can read imported notes.',
            secret: false,
            reconnect: true,
            required: true,
            default: false,
            consent: true,
          },
          createPeople: {
            type: 'string' as const,
            label: 'Create contacts',
            secret: false,
            reconnect: false,
            required: true,
            default: 'never',
            options: ['never', 'contacted_first', 'everyone'],
          },
        },
      },
    };
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    mount(
      <ExtensionSetup release={choices} mode="install" onCancel={() => {}} onDone={() => {}} />,
    );
    expect(
      screen.getByText('Everyone in this Retainer workspace can read imported notes.'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: /^Share accessible notes/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    expect(plan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Share accessible notes/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls[0]?.[0].settings).toEqual({ share: true, createPeople: 'never' });
  });

  const installation: NonNullable<React.ComponentProps<typeof ExtensionSetup>['installation']> = {
    id: 'installation',
    registrationId: release.manifest.universalId,
    version: '1.0.0',
    releaseDigest: release.digest,
    state: 'active',
    generation: 1,
    grantGeneration: 1,
    settingsRevision: 1,
    settings: { enabled: true },
    secrets: { apiKey: true },
    grantedActor: 'agent',
    grantedScopes: ['read'],
    grantedUses: [],
    createdBy: { type: 'user', id: 'admin' },
  };
  it('explains unavailable execution while keeping the provider connection separate', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({
      installations: [
        {
          ...installation,
          connectionHealth: 'ok',
          runtimeAvailability: { state: 'unavailable', code: 'release_unavailable' },
        },
      ],
    });
    router.params = { id: installation.id };
    mount(<ExtensionPage />);
    expect(await screen.findByText(/Your server cannot run this extension right now/)).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText(/Pending work is saved/)).toBeTruthy();
    expect(screen.queryByText(/Needs attention:/)).toBeNull();
  });
  it('marks an update on the installed card and offers it on the extension page', async () => {
    const upgraded = { ...release, manifest: { ...release.manifest, version: '1.0.10' } };
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [upgraded, release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({
      installations: [{ ...installation, connectionHealth: 'ok' }],
    });
    mount(<ExtensionsPage />);
    const card = await screen.findByRole('link', { name: /Fixture/ });
    expect(card.getAttribute('href')).toBe('/extensions/installation');
    expect(within(card).getByText('Update available')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Set up/ })).toBeNull();
    cleanup();
    router.params = { id: installation.id };
    mount(<ExtensionPage />);
    // 1.0.10 is newer than 1.0.0: versions compare numerically, not as text.
    const upgrade = await screen.findByRole('link', { name: 'Upgrade to 1.0.10' });
    expect(upgrade.getAttribute('href')).toBe('/extensions/installation/upgrade');
    expect(screen.getByText(/Version 1\.0\.10 is available/)).toBeTruthy();
  });
  it('shows no upgrade when the installed release is the newest', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({
      installations: [{ ...installation, connectionHealth: 'ok' }],
    });
    router.params = { id: installation.id };
    mount(<ExtensionPage />);
    expect(await screen.findByRole('button', { name: 'Runs' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Upgrade to/ })).toBeNull();
    expect(screen.queryByText(/is available/)).toBeNull();
  });
  it('creates only selected app access, shows the returned key once and discards it when closing', async () => {
    const rawKey = 'rti_shown_once_only';
    vi.spyOn(api, 'extensionCredentials').mockResolvedValue({ credentials: [] });
    const issue = vi.spyOn(api, 'createExtensionKey').mockResolvedValue({
      id: 'credential',
      key: rawKey,
      prefix: 'rti_shown',
      generation: 1,
      scopes: ['read'],
      createdAt: '2026-11-11T10:00:00Z',
    });
    mount(<InstallationCredentials installation={installation} />);
    expect(screen.queryByDisplayValue(rawKey)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create installation key' }));
    expect(await screen.findByDisplayValue(rawKey)).toBeTruthy();
    expect(issue).toHaveBeenCalledWith(installation.id, {
      expectedGeneration: 1,
      scopes: ['read'],
    });
    expect(screen.getByText('Copy this key now. It is shown only once.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue(rawKey)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create installation key' })).toBeTruthy();
  });
  it('lists safe credential prefixes and explicitly revokes the selected app credential', async () => {
    vi.spyOn(api, 'extensionCredentials').mockResolvedValue({
      credentials: [
        {
          id: 'credential',
          kind: 'key',
          prefix: 'rti_visible',
          clientId: null,
          generation: 1,
          scopes: ['read'],
          createdAt: '2026-11-11T10:00:00Z',
          revokedAt: null,
          active: true,
        },
      ],
    });
    const revoke = vi.spyOn(api, 'revokeExtensionCredential').mockResolvedValue({ revoked: true });
    mount(<InstallationCredentials installation={installation} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke rti_visible' }));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(installation.id, 'credential'));
  });
  it('manages accounts-mode OAuth connections without offering installation keys', async () => {
    vi.spyOn(api, 'extensionCredentials').mockResolvedValue({
      credentials: [
        {
          id: 'oauth',
          kind: 'oauth',
          prefix: null,
          clientId: 'reviewed-client',
          generation: 1,
          scopes: ['read'],
          createdAt: '2026-11-11T10:00:00Z',
          revokedAt: null,
          active: true,
        },
      ],
    });
    const revoke = vi.spyOn(api, 'revokeExtensionCredential').mockResolvedValue({ revoked: true });
    mount(<InstallationCredentials installation={installation} keyMode={false} />);
    expect(screen.queryByRole('button', { name: 'Create installation key' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke connection' }));
    expect(revoke).toHaveBeenCalledWith(installation.id, 'oauth');
  });
  it('keeps credential edits behind reconnect review and sends only staged references after human approval', async () => {
    vi.spyOn(api, 'stageExtensionSecret').mockResolvedValue({
      pendingSecretId: 'new-reference',
      installationId: installation.id,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue({
      ...preview,
      previousGrants: { actor: 'agent', scopes: ['read'], uses: [] },
    });
    const reconnect = vi
      .spyOn(api, 'reconnectExtension')
      .mockResolvedValue({ ...installation, generation: 2, state: 'installing' });
    const update = vi.spyOn(api, 'updateExtensionSettings');
    mount(
      <ExtensionSetup
        release={release}
        installation={installation}
        mode="reconnect"
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('API key (required)'), 'new-sensitive-key');
    await userEvent.click(screen.getByRole('button', { name: 'Review reconnect' }));
    expect(await screen.findByRole('button', { name: 'Approve reconnect' })).toBeTruthy();
    expect(reconnect).not.toHaveBeenCalled();
    expect(plan.mock.calls[0]?.[0]).toMatchObject({
      installationId: installation.id,
      reconnect: true,
      replaceSourceAccount: false,
      grantChange: true,
      secretRefs: { apiKey: 'new-reference' },
    });
    expect(JSON.stringify(plan.mock.calls)).not.toContain('new-sensitive-key');
    await userEvent.click(screen.getByRole('button', { name: 'Approve reconnect' }));
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    expect(update).not.toHaveBeenCalled();
    expect(JSON.stringify(reconnect.mock.calls)).not.toContain('new-sensitive-key');
  });
  it('shows the previous access and a distinct approval button when an upgrade requests more access', async () => {
    const upgraded = { ...release, manifest: { ...release.manifest, version: '1.1.0' } };
    vi.spyOn(api, 'previewExtension').mockResolvedValue({
      ...preview,
      previousGrants: { actor: 'agent', scopes: ['read'], uses: [] },
    });
    const upgrade = vi
      .spyOn(api, 'upgradeExtension')
      .mockResolvedValue({ ...installation, version: '1.1.0' });
    mount(
      <ExtensionSetup
        release={upgraded}
        installation={installation}
        mode="upgrade"
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review upgrade' }));
    expect(
      await screen.findByText(/This approval changes access from read as an agent/),
    ).toBeTruthy();
    expect(upgrade).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve access and upgrade' }));
    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledTimes(1));
  });

  it('stages secrets separately, shows the approval, and sends opaque references with a durable retry key', async () => {
    const stage = vi.spyOn(api, 'stageExtensionSecret').mockResolvedValue({
      pendingSecretId: 'opaque-reference',
      installationId: 'draft-installation',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    const install = vi.spyOn(api, 'installExtension').mockRejectedValue(new Error('Try again'));
    const onDone = vi.fn();
    mount(<ExtensionSetup release={release} mode="install" onCancel={() => {}} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText('API key (required)'), 'sensitive-fixture');
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    expect(await screen.findByRole('button', { name: 'Approve installation' })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({ value: 'sensitive-fixture' }));
    expect(plan.mock.calls[0]?.[0]).toMatchObject({
      settings: { enabled: false },
      secretRefs: { apiKey: 'opaque-reference' },
    });
    expect(JSON.stringify(plan.mock.calls)).not.toContain('sensitive-fixture');
    expect(screen.getByText('Runtime activation is unavailable.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve installation' }));
    expect(await screen.findByText('Try again')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve installation' }));
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(install.mock.calls[0]?.[1]).toBe(install.mock.calls[1]?.[1]);
    expect(JSON.stringify(install.mock.calls)).not.toContain('sensitive-fixture');
    expect(onDone).not.toHaveBeenCalled();
  });
  it('renders read-only catalog access without install controls for non-admins', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [] });
    mount(<ExtensionsPage />, false);
    expect(await screen.findByText('A workspace admin can set up these extensions.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Set up/ })).toBeNull();
  });
  it('walks the setup steps, goes back to edit, and opens the installation once approved', async () => {
    vi.spyOn(api, 'stageExtensionSecret').mockResolvedValue({
      pendingSecretId: 'opaque-reference',
      installationId: 'draft-installation',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    vi.spyOn(api, 'installExtension').mockResolvedValue({ ...installation, id: 'installed' });
    const onDone = vi.fn(),
      onCancel = vi.fn();
    mount(<ExtensionSetup release={release} mode="install" onCancel={onCancel} onDone={onDone} />);
    const steps = screen.getByRole('navigation', { name: 'Set up Fixture steps' });
    expect(
      within(steps)
        .getByRole('button', { name: /Connect/ })
        .getAttribute('aria-current'),
    ).toBe('step');
    // A later step cannot be opened before the earlier ones are done.
    expect(
      (within(steps).getByRole('button', { name: /Review and approve/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await userEvent.type(screen.getByLabelText('API key (required)'), 'sensitive-fixture');
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    expect(await screen.findByRole('button', { name: 'Approve installation' })).toBeTruthy();
    expect(screen.queryByLabelText('API key (required)')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Approve installation' })).toBeNull();
    // The staged key is kept: it does not have to be typed again.
    expect((screen.getByLabelText('API key (required)') as HTMLInputElement).placeholder).toBe(
      'Provided for approval',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve installation' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('installed'));
    expect(plan).toHaveBeenCalledTimes(2);
    expect(onCancel).not.toHaveBeenCalled();
  });
  it('asks before uninstalling from the extension page', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [installation] });
    const uninstall = vi
      .spyOn(api, 'uninstallExtension')
      .mockResolvedValue({ ...installation, state: 'uninstalling' });
    router.params = { id: installation.id };
    mount(<ExtensionPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Extension actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Uninstall' }));
    const confirm = await screen.findByRole('dialog', { name: 'Uninstall Fixture?' });
    expect(uninstall).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Uninstall' }));
    await vi.waitFor(() => expect(uninstall).toHaveBeenCalledWith(installation.id));
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/extensions' }));
  });
  it('saves settings on the Settings tab and sends credential changes to Reconnect', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    const list = vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [installation] });
    const update = vi.spyOn(api, 'updateExtensionSettings').mockImplementation(async () => {
      const saved = { ...installation, settings: { enabled: false }, settingsRevision: 2 };
      list.mockResolvedValue({ installations: [saved] });
      return saved;
    });
    router.params = { id: installation.id };
    router.search = { tab: 'settings' };
    mount(<ExtensionPage />);
    expect(((await screen.findByLabelText(/^API key/)) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Change credentials' }).getAttribute('href')).toBe(
      '/extensions/installation/reconnect',
    );
    await userEvent.click(screen.getByLabelText(/^Enabled/));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(installation.id, {
        expectedRevision: 1,
        settings: { enabled: false },
      }),
    );
    // The form reloads from the new revision and still says it was saved.
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Settings saved.')).toBeTruthy();
  });
});
