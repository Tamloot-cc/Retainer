import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HomeCard, HomeWelcome } from './feed.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe('Home feed', () => {
  it('offers the dedicated review inbox only when work is waiting', () => {
    const { rerender } = render(<HomeWelcome reviewCount={0} />);
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<HomeWelcome reviewCount={3} />);
    expect(
      screen.getByRole('link', { name: /3 items need your review/ }).getAttribute('href'),
    ).toBe('/review');
  });
  it('keeps record links and expansion controls independent and keyboard accessible', () => {
    render(
      <HomeCard
        record={{ id: 'sarah', object: 'person' }}
        label="Sarah Cohen"
        type="Person · Updated"
        title={<button type="button">Sarah Cohen</button>}
        time="10:32 AM"
        footer={<a href="/r/sarah">Open record</a>}
      >
        <button type="button">Show more updates</button>
      </HomeCard>,
    );
    expect(screen.getByRole('article')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Sarah Cohen' }).querySelector('a,button'),
    ).toBeNull();
    expect(screen.getByRole('link', { name: 'Open record' }).closest('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more updates' })).toBeTruthy();
  });
});
