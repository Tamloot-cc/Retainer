import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Account, account as api } from '../api/account.js';
import { OAuthConsent } from './oauth.js';

const account: Account = {
  user: { id: 'admin', name: 'Dana', email: 'dana@example.test' },
  providers: ['google'],
  invitations: [],
  organizations: [
    {
      id: 'org',
      name: 'Organization',
      role: 'member',
      workspaces: [
        { id: 'workspace', name: 'Sales', slug: 'sales', role: 'admin' },
        { id: 'other', name: 'Read-only', slug: 'other', role: 'viewer' },
      ],
    },
  ],
};
function mount(resource = '/v1', as = account) {
  window.history.replaceState(
    {},
    '',
    `/app/oauth/consent?${new URLSearchParams({
      resource: `${window.location.origin}${resource}`,
      client_id: 'reviewed-client',
      scope: 'read write offline_access',
      redirect_uri: 'https://app.example/callback',
    })}`,
  );
  vi.spyOn(api, 'oauthClient').mockResolvedValue({
    clientId: 'reviewed-client',
    name: 'Workspace app',
    uri: 'https://app.example',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <OAuthConsent account={as} />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/app/');
});
describe('reviewed workspace app consent', () => {
  it('shows only admin workspaces and the approved actor, then binds approval to the installation generation', async () => {
    const options = vi.spyOn(api, 'oauthInstallations').mockResolvedValue({
      installations: [
        {
          id: 'installation',
          name: 'Reviewed app',
          version: '1.0.0',
          generation: 3,
          actor: 'integration',
          scopes: ['read', 'write'],
        },
      ],
    });
    const approve = vi
      .spyOn(api, 'oauthConsent')
      .mockRejectedValue(new Error('Test stops before redirect'));
    mount();
    expect(await screen.findByText(/Reviewed app will act as an integration/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Read-only' })).toBeNull();
    expect(screen.getByText(/continues if you leave/)).toBeTruthy();
    expect(screen.getByText(/cannot read your personal memory/)).toBeTruthy();
    expect(options).toHaveBeenCalledWith('reviewed-client', 'workspace');
    expect(approve).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('Test stops before redirect')).toBeTruthy();
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        accept: true,
        workspaceId: 'workspace',
        installationId: 'installation',
        expectedGeneration: 3,
      }),
    );
  });
  it('requires an existing approved installation and never silently widens its scopes', async () => {
    vi.spyOn(api, 'oauthInstallations').mockResolvedValue({
      installations: [
        {
          id: 'installation',
          name: 'Read-only app',
          version: '1.0.0',
          generation: 1,
          actor: 'agent',
          scopes: ['read'],
        },
      ],
    });
    mount();
    expect(await screen.findByText(/Read-only app will act as an agent/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('keeps personal MCP consent on its existing workspace picker and person identity', async () => {
    const options = vi.spyOn(api, 'oauthInstallations');
    mount('/mcp');
    expect(await screen.findByText(/as Dana/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Read-only/ })).toBeTruthy();
    expect(screen.getByText(/Its changes show as/)).toBeTruthy();
    expect(options).not.toHaveBeenCalled();
  });
});
