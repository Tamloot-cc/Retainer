import type { ReactNode } from 'react';
import { type Mock, vi } from 'vitest';

/**
 * The router as the extension pages see it in unit tests: the address's
 * params and search, a spy for navigation, and links as plain anchors.
 * Mock the router with it through a dynamic import, since `vi.mock` is hoisted.
 */
export const router: {
  navigate: Mock;
  params: Record<string, string>;
  search: Record<string, unknown>;
  reset: () => void;
} = {
  navigate: vi.fn(),
  params: {} as Record<string, string>,
  search: {} as Record<string, unknown>,
  reset() {
    this.navigate.mockReset();
    this.params = {};
    this.search = {};
  },
};

const href = (to: string, params?: Record<string, string>, search?: unknown) => {
  const path = to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? '');
  if (!search || typeof search !== 'object') return path;
  const query = new URLSearchParams(search as Record<string, string>).toString();
  return query ? `${path}?${query}` : path;
};

function MockLink({
  children,
  to,
  params,
  search,
  'aria-label': label,
}: {
  children: ReactNode;
  to: string;
  params?: Record<string, string>;
  search?: unknown;
  'aria-label'?: string;
}) {
  return (
    <a href={href(to, params, search)} aria-label={label}>
      {children}
    </a>
  );
}

export async function mockRouter(original: () => Promise<unknown>): Promise<object> {
  return {
    ...(await (original() as Promise<object>)),
    Link: MockLink,
    useNavigate: () => router.navigate,
    useParams: () => router.params,
    useSearch: () => router.search,
  };
}
