import type { SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { DashboardsPage } from './pages.js';

vi.mock('@tanstack/react-router', async (original) =>
  (await import('../extensions/test-router.js')).mockRouter(original),
);

function show(scopes: string[]) {
  vi.spyOn(api, 'dashboards').mockResolvedValue({ dashboards: [] } as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'dana', name: 'Dana' },
            agentAvailable: true,
            scopes,
            workspace: { id: 'workspace' },
          } as Session,
          schema: { objects: [] } as unknown as SchemaDescription,
        }}
      >
        <DashboardsPage />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('Dashboards page entries (chat-builds.md §5.2)', () => {
  it('links New dashboard and the empty state to the starter for a writer', async () => {
    show(['read', 'write']);
    expect((await screen.findByRole('link', { name: 'Open chat' })).getAttribute('href')).toBe(
      '/chat?new=dashboard',
    );
    expect(screen.getByRole('link', { name: 'New dashboard' }).getAttribute('href')).toBe(
      '/chat?new=dashboard',
    );
  });

  it('gives a reader a plain chat and no New dashboard', async () => {
    show(['read']);
    expect((await screen.findByRole('link', { name: 'Open chat' })).getAttribute('href')).toBe(
      '/chat',
    );
    expect(screen.queryByRole('link', { name: 'New dashboard' })).toBeNull();
  });
});
