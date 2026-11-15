import type { Session } from '@retainer/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../api/account.js';
import { CANNOT_FINISH, ConnectCallback, SIGN_IN_FIRST } from './callback.js';
import { navigation, parseConnectState } from './connect-return.js';

const WORKSPACE = '0f0e4c38-8c4b-4a9b-9b1e-2f1d3b4a5c6d';
const INSTALLATION = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STATE = `v1.${WORKSPACE}.${INSTALLATION}.Qm9vdHN0cmFwLW5vbmNlLTMyLWJ5dGVzLWxvbmc`;
const account: Account = {
  user: { id: 'member', name: 'Dana', email: 'dana@example.test' },
  providers: ['google'],
  invitations: [],
  organizations: [
    {
      id: 'org',
      name: 'Organization',
      role: 'member',
      workspaces: [{ id: WORKSPACE, name: 'Sales', slug: 'sales', role: 'editor' }],
    },
  ],
};
const stranger: Account = {
  ...account,
  organizations: [
    { ...(account.organizations[0] as Account['organizations'][number]), workspaces: [] },
  ],
};

function at(query: Record<string, string>) {
  window.history.replaceState(null, '', `/app/connect/callback?${new URLSearchParams(query)}`);
}
function respond(status: number, body: unknown) {
  return vi.spyOn(window, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}
const sent = (fetch: ReturnType<typeof respond>) => {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/app/');
});

describe('the OAuth callback page', () => {
  it('reads only well-formed states', () => {
    expect(parseConnectState(STATE)).toEqual({
      workspaceId: WORKSPACE,
      installationId: INSTALLATION,
    });
    for (const bad of [
      null,
      '',
      'v2.a.b.c',
      'v1.a.b',
      'v1.a.b.c.d',
      'v1..b.c',
      'v1.a/../b.c.d',
      'v1.a.b.c%20',
    ])
      expect(parseConnectState(bad)).toBeNull();
  });
  // Key mode first: an accounts-mode test opens a workspace on the shared client.
  it('completes in key mode for the key’s workspace, without a workspace header', async () => {
    at({ state: STATE, code: 'the-code' });
    const fetch = respond(200, { id: 'connection', state: 'connecting' });
    const replace = vi.spyOn(navigation, 'replace').mockImplementation(() => {});
    render(<ConnectCallback session={{ workspace: { id: WORKSPACE } } as Session} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/app/extensions/${INSTALLATION}`));
    expect(sent(fetch).headers['X-Retainer-Workspace']).toBeUndefined();
  });
  it('refuses a key-mode state for another workspace', async () => {
    at({ state: STATE, code: 'the-code' });
    const fetch = respond(200, {});
    render(<ConnectCallback session={{ workspace: { id: 'other' } } as Session} />);
    expect(await screen.findByText(CANNOT_FINISH, { exact: false })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('completes in the workspace named by the state and lands on the Connections tab', async () => {
    sessionStorage.setItem(`retainer:connect:${STATE}`, '{}');
    at({ state: STATE, code: 'the-code' });
    const fetch = respond(200, { id: 'connection', state: 'connecting' });
    const replace = vi.spyOn(navigation, 'replace').mockImplementation(() => {});
    render(<ConnectCallback account={account} />);
    // The code leaves the address bar before anything else.
    expect(window.location.search).toBe('');
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/app/w/sales/extensions/${INSTALLATION}`),
    );
    const request = sent(fetch);
    expect(request.url).toBe(
      `${window.location.origin}/v1/extensions/${INSTALLATION}/connections/authorize/complete`,
    );
    expect(request.headers['X-Retainer-Workspace']).toBe(WORKSPACE);
    expect(request.body).toEqual({ state: STATE, code: 'the-code' });
    expect(sessionStorage.getItem(`retainer:connect:${STATE}`)).toBeNull();
  });
  it('lands with connect=declined when the member declined', async () => {
    at({ state: STATE, error: 'access_denied' });
    const fetch = respond(200, { cancelled: true });
    const replace = vi.spyOn(navigation, 'replace').mockImplementation(() => {});
    render(<ConnectCallback account={account} />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/app/w/sales/extensions/${INSTALLATION}?connect=declined`,
      ),
    );
    expect(sent(fetch).body).toEqual({ state: STATE, error: 'access_denied' });
  });
  it('lands with connect=failed when completing fails for another reason', async () => {
    at({ state: STATE, code: 'the-code' });
    respond(500, { error: { code: 'internal', message: 'Boom' } });
    const replace = vi.spyOn(navigation, 'replace').mockImplementation(() => {});
    render(<ConnectCallback account={account} />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/app/w/sales/extensions/${INSTALLATION}?connect=failed`,
      ),
    );
  });
  it('shows the generic message for an expired, used or someone else’s request', async () => {
    at({ state: STATE, code: 'the-code' });
    respond(409, { error: { code: 'authorization_expired', message: 'Expired.' } });
    const replace = vi.spyOn(navigation, 'replace').mockImplementation(() => {});
    render(<ConnectCallback account={account} />);
    expect(await screen.findByText(CANNOT_FINISH, { exact: false })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
  it('never posts for a workspace the person is not a member of', async () => {
    at({ state: STATE, code: 'the-code' });
    const fetch = respond(200, {});
    render(<ConnectCallback account={stranger} />);
    expect(await screen.findByText(CANNOT_FINISH, { exact: false })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['a tampered state', { state: 'v1.not-a-state', code: 'c' }],
    ['no state', { code: 'c' }],
    ['both a code and an error', { state: STATE, code: 'c', error: 'access_denied' }],
    ['neither a code nor an error', { state: STATE }],
  ])('shows the generic message for %s', async (_, query) => {
    at(query);
    const fetch = respond(200, {});
    render(<ConnectCallback account={account} />);
    expect(await screen.findByText(CANNOT_FINISH, { exact: false })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('asks a browser that is not signed in to sign in, and never posts the code', async () => {
    at({ state: STATE, code: 'the-code' });
    const fetch = respond(200, {});
    render(<ConnectCallback />);
    expect(await screen.findByText(SIGN_IN_FIRST, { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Retainer' }).getAttribute('href')).toBe('/app/');
    expect(window.location.search).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
});
