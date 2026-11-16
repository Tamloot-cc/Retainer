import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { objectIcon, Shell } from './shell.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children, 'aria-label': label }: { children: ReactNode; 'aria-label'?: string }) => (
    <a href="/" aria-label={label}>
      {children}
    </a>
  ),
}));

function shell(collapsed: boolean) {
  localStorage.setItem('retainer:sidebar:collapsed', collapsed ? '1' : '0');
  render(
    <Shell
      workspace="Acme"
      user={{ name: 'Dana Levi', detail: 'User' }}
      objects={[
        { name: 'company', label: 'Companies', class: 'entity' },
        { name: 'conversation', label: 'Conversations', class: 'event' },
        { name: 'person', label: 'People', class: 'entity' },
        { name: 'note', label: 'Notes', class: 'event' },
      ]}
      developer={false}
      onDeveloperChange={vi.fn()}
      onSignOut={vi.fn()}
      onSearch={vi.fn()}
    >
      <p>Page</p>
    </Shell>,
  );
}

describe('the sidebar', () => {
  it('places Home above the record and event groups', () => {
    shell(false);
    const records = screen.getByRole('group', { name: 'Records' });
    expect(
      within(records)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Companies', 'People']);
    const activity = screen.getByRole('group', { name: 'Activity' });
    expect(
      within(activity)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Conversations', 'Notes']);
    expect(
      within(screen.getByRole('navigation', { name: 'Main navigation' }))
        .getAllByRole('link')
        .slice(0, 2)
        .map((link) => link.textContent),
    ).toEqual(['Home', 'Review inbox']);
    expect(screen.getByRole('button', { name: 'Account: Dana Levi' })).toBeTruthy();
  });

  it('keeps both groups, divided, in the icon rail', () => {
    shell(true);
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Records' })).toBeTruthy();
  });

  it('draws event types from their own family of icons', () => {
    expect(objectIcon('note', 'event')).not.toBe(objectIcon('note'));
    expect(objectIcon('custom', 'event')).not.toBe(objectIcon('custom'));
    expect(objectIcon('conversation', 'event')).not.toBe(objectIcon('custom', 'event'));
  });
});
