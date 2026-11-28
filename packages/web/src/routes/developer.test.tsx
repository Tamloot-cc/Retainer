import type { ObjectView, PresentedRecord, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import {
  DeveloperContext,
  readViewLevel,
  useAgentView,
  useDeveloper,
  VIEW_LEVEL_KEY,
  type ViewLevel,
  writePath,
  writeViewLevel,
} from './developer.js';
import { RecordView } from './records/record-view.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
afterEach(() => vi.restoreAllMocks());

/** Prints what the two hooks say at the level it is given. */
function Probe() {
  return (
    <p>
      {String(useDeveloper())} {String(useAgentView())}
    </p>
  );
}

describe('the View control', () => {
  it('remembers its level per browser, and is Standard when storage is refused', () => {
    const store = new Map<string, string>();
    const storage = () => ({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readViewLevel(storage)).toBe('off');
    for (const level of ['developer', 'agent', 'off'] as const) {
      expect(writeViewLevel(storage, level)).toBe(true);
      expect(store.get(VIEW_LEVEL_KEY)).toBe(level);
      expect(readViewLevel(storage)).toBe(level);
    }
    // The old switch's key is no longer read, and an unknown value is Standard.
    store.set('retainer:developer-view:v1', '1');
    store.set(VIEW_LEVEL_KEY, 'everything');
    expect(readViewLevel(storage)).toBe('off');
    const refused = () => {
      throw new Error('SecurityError');
    };
    expect(readViewLevel(refused)).toBe('off');
    expect(writeViewLevel(refused, 'agent')).toBe(false);
  });

  it('nests the levels: Developer is on at Agent too', () => {
    const at = (level: ViewLevel) => {
      const { container, unmount } = render(
        <DeveloperContext.Provider value={{ level, set: vi.fn() }}>
          <Probe />
        </DeveloperContext.Provider>,
      );
      const text = container.textContent;
      unmount();
      return text;
    };
    expect(at('off')).toBe('false false');
    expect(at('developer')).toBe('true false');
    expect(at('agent')).toBe('true true');
  });

  it('names how each class is written', () => {
    expect(writePath({ class: 'entity', nameSingular: 'company' }, 'r1')).toEqual({
      tool: 'upsert_record',
      routes: ['POST /v1/objects/company/upsert', 'PATCH /v1/records/r1'],
    });
    expect(writePath({ class: 'event', nameSingular: 'note' }, 'e1')).toEqual({
      tool: 'log_event',
      routes: ['POST /v1/events'],
    });
  });
});

describe('a record in developer view', () => {
  const company = {
    nameSingular: 'company',
    labelSingular: 'Company',
    class: 'entity',
    fields: [
      {
        name: 'domain',
        label: 'Domain',
        description: 'The company’s main website domain, without https.',
        type: 'text',
        settings: {},
        readOnly: false,
        isNullable: true,
      },
    ],
  } as unknown as ObjectView;
  const acme = {
    id: 'c1',
    object: 'company',
    label: 'Acme',
    updatedAt: '2026-11-03T12:00:00.000Z',
    createdBy: { type: 'user', id: 'dana' },
    fields: { domain: 'acme.test' },
  } as unknown as PresentedRecord;

  function show(on: boolean | ViewLevel, tab?: string) {
    const level: ViewLevel = on === true ? 'developer' : on === false ? 'off' : on;
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [], nextCursor: null } as never);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'user', id: 'dana' },
              scopes: ['read'],
            } as unknown as Session,
            schema: { objects: [company] } as unknown as SchemaDescription,
          }}
        >
          <DeveloperContext.Provider value={{ level, set: vi.fn() }}>
            <RecordView record={acme} requestedId="c1" nav={{ tab, set: vi.fn() }} />
          </DeveloperContext.Provider>
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
  }

  it('shows nothing extra when off', () => {
    show(false, 'json');
    expect(screen.queryByText('upsert_record')).toBeNull();
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(screen.queryByText('domain')).toBeNull();
    // A JSON tab in the address falls back to the first tab.
    expect(screen.getByRole('button', { name: 'Facts' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the class, ID, write path, API names and the record as JSON when on', async () => {
    show(true, 'json');
    expect(screen.getByText('entity')).toBeTruthy();
    expect(screen.getByText('c1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeTruthy();
    expect(screen.getByText('upsert_record')).toBeTruthy();
    expect(screen.getByText('PATCH /v1/records/c1')).toBeTruthy();
    expect(screen.getByText('domain')).toBeTruthy();
    const json = screen.getByLabelText('Record JSON');
    expect(JSON.parse(json.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(acme)));
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: copy } });
    await userEvent.click(screen.getByRole('button', { name: 'Copy ID' }));
    expect(copy).toHaveBeenCalledWith('c1');
  });

  it('shows field descriptions under labels only in agent view', () => {
    const description = 'The company’s main website domain, without https.';
    show(true);
    expect(screen.queryByText(description)).toBeNull();
    cleanup();
    show('agent');
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByText('domain')).toBeTruthy();
  });
});
