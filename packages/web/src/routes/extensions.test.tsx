import type { SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { ExtensionSettings, ExtensionsPage } from './extensions.js';

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
  grants: { actor: 'integration', scopes: ['read', 'write'] },
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
afterEach(() => vi.restoreAllMocks());
describe('generated extension settings and human approval', () => {
  it('stages secrets separately, shows the approval, and sends opaque references with a durable retry key', async () => {
    const stage = vi.spyOn(api, 'stageExtensionSecret').mockResolvedValue({
      pendingSecretId: 'opaque-reference',
      installationId: 'draft-installation',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    const install = vi.spyOn(api, 'installExtension').mockRejectedValue(new Error('Try again'));
    mount(<ExtensionSettings release={release} onClose={() => {}} onSaved={() => {}} />);
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
  });
  it('renders read-only catalog access without install controls for non-admins', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [] });
    mount(<ExtensionsPage />, false);
    expect(await screen.findByText('A workspace admin can connect this service.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });
});
