import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  SchemaDescription,
  Session,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { defaultMemoryTab, MemoryTabs, memoryTabs } from './record-memory.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const object = (name: string, extra: Partial<ObjectView> = {}) =>
  ({
    nameSingular: name,
    labelSingular: name,
    labelPlural: `${name}s`,
    class: 'entity',
    fields: [],
    ...extra,
  }) as unknown as ObjectView;

const deal = object('deal', {
  fields: [
    {
      name: 'state',
      type: 'select',
      settings: {
        options: [
          { value: 'todo', label: 'To do' },
          { value: 'in_progress', label: 'In progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'done', label: 'Done' },
        ],
      },
    } as unknown as FieldView,
  ],
});
const schema = {
  objects: [object('company'), object('person'), deal, object('conversation', { class: 'event' })],
} as unknown as SchemaDescription;

const labels = (tabs: { label: string }[]) => tabs.map((t) => t.label);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('which tabs a record has', () => {
  const entity = { isEvent: false, developer: false };

  it('gives an entity its memory, comments first', () => {
    expect(labels(memoryTabs(entity))).toEqual([
      'Comments',
      'Facts',
      'Activity',
      'History',
      'Linked',
    ]);
  });

  it('gives an event comments, claims and history, and none of what an entity has (5.1)', () => {
    expect(labels(memoryTabs({ ...entity, isEvent: true }))).toEqual([
      'Comments',
      'Claims',
      'History',
    ]);
  });

  it('adds JSON in the developer view', () => {
    expect(labels(memoryTabs({ ...entity, developer: true })).at(-1)).toBe('JSON');
  });

  it('keeps Facts on an event only when facts are stored on it, so none become unreachable', () => {
    const event = { ...entity, isEvent: true };
    const counts = { comments: 0, facts: 2, linked: 0, claims: 0 };
    expect(memoryTabs({ ...event, counts }).map((t) => [t.label, t.count])).toEqual([
      ['Comments', undefined],
      ['Claims', undefined],
      ['History', undefined],
      ['Facts', 2],
    ]);
    expect(labels(memoryTabs({ ...event, counts: { ...counts, facts: 0 } }))).not.toContain(
      'Facts',
    );
    expect(defaultMemoryTab(true, counts)).toBe('comments');
  });

  it('counts only what there is, and never fans out to count activity', () => {
    const tabs = memoryTabs({
      ...entity,
      counts: { comments: 2, facts: 0, linked: 3, claims: 9 },
    });
    expect(tabs.map((t) => [t.label, t.count])).toEqual([
      ['Comments', 2],
      ['Facts', undefined],
      ['Activity', undefined],
      ['History', undefined],
      ['Linked', 3],
    ]);
    expect(
      memoryTabs({
        ...entity,
        isEvent: true,
        counts: { comments: 0, facts: 0, linked: 1, claims: 4 },
      }).map((t) => t.count),
    ).toEqual([undefined, 4, undefined]);
  });

  it('opens where people wrote something, then on what agents remember', () => {
    expect(defaultMemoryTab(false)).toBe('facts');
    expect(defaultMemoryTab(false, { comments: 0, facts: 2, linked: 0, claims: 0 })).toBe('facts');
    expect(defaultMemoryTab(false, { comments: 1, facts: 2, linked: 0, claims: 0 })).toBe(
      'comments',
    );
    expect(defaultMemoryTab(true)).toBe('comments');
  });
});

describe('MemoryTabs', () => {
  const record = (over: Partial<PresentedRecord>) =>
    ({
      id: 'r1',
      object: 'company',
      label: 'Acme',
      fields: {},
      createdBy: { type: 'user', id: 'dana' },
      ...over,
    }) as unknown as PresentedRecord;

  function show(r: PresentedRecord, tab?: string, { fact }: { fact?: string } = {}) {
    const set = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'user', id: 'dana' },
              scopes: ['read', 'write'],
            } as unknown as Session,
            schema,
          }}
        >
          <MemoryTabs record={r} nav={{ tab, fact, set }} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    return set;
  }

  it('falls back to where the record opens when the address names a tab it lacks', () => {
    vi.spyOn(api, 'listComments').mockResolvedValue({ items: [], nextCursor: null } as never);
    show(record({ object: 'conversation', event: {} as never }), 'facts');
    expect(screen.getByRole('button', { name: 'Comments' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('button', { name: 'Facts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Linked' })).toBeNull();
  });

  it('explains the current tab in plain words from its info button', async () => {
    vi.spyOn(api, 'listComments').mockResolvedValue({ items: [], nextCursor: null } as never);
    vi.spyOn(api, 'claims').mockResolvedValue({
      assertions: [],
      facts: [],
      nextCursors: { assertions: null, facts: null },
    } as never);
    show(record({ object: 'conversation', event: {} as never }), 'claims');
    expect(screen.queryByRole('button', { name: 'About Comments' })).toBeNull();
    await userEvent.hover(screen.getByRole('button', { name: 'About Claims' }));
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'What came out of this event',
    );
  });

  it('asks for the new tab and clears the last tab’s filters', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [], nextCursor: null } as never);
    const set = show(record({ object: 'deal' }));
    expect(screen.getByRole('button', { name: 'Linked' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(set).toHaveBeenCalledWith({
      tab: 'history',
      fields: undefined,
      fact: undefined,
    });
  });

  it('pages a list by adding to it, keeping what is shown', async () => {
    const fact = (id: string, content: string) => ({
      id,
      record: 'r1',
      content,
      kind: 'stated',
      validFrom: '2026-11-01T09:00:00.000Z',
      validTo: null,
      writtenBy: { type: 'agent', id: 'bot' },
      sources: [],
    });
    const facts = vi
      .spyOn(api, 'facts')
      .mockResolvedValueOnce({ facts: [fact('f1', 'one')], nextCursor: 'c2' } as never)
      .mockResolvedValueOnce({ facts: [fact('f2', 'two')], nextCursor: null } as never);
    show(record({}));
    expect(await screen.findByText('one')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('two')).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
    expect(facts.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByRole('button', { name: /First page|Next page/ })).toBeNull();
  });

  it('loads later fact pages and focuses the fact selected from search', async () => {
    const fact = (id: string) => ({
      id,
      record: 'r1',
      content: id,
      kind: 'stated',
      validFrom: '2026-11-01T09:00:00.000Z',
      validTo: null,
      writtenBy: { type: 'agent', id: 'bot' },
      sources: [],
    });
    const facts = vi
      .spyOn(api, 'facts')
      .mockResolvedValueOnce({ facts: [fact('f1')], nextCursor: 'c2' } as never)
      .mockResolvedValueOnce({ facts: [fact('f2')], nextCursor: null } as never);
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    try {
      show(record({}), 'facts', { fact: 'f2' });
      await vi.waitFor(() => expect(document.activeElement?.id).toBe('fact-f2'));
      expect(facts.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c2' });
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(facts).toHaveBeenCalledTimes(2);
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('groups linked pages by object and displays the schema’s select labels', async () => {
    const linked = vi
      .spyOn(api, 'linkedRecords')
      .mockResolvedValueOnce({
        items: [
          {
            id: 'd1',
            title: 'Expansion',
            object: 'deal',
            via: 'company',
            selects: { state: 'done' },
          },
        ],
        totals: { deal: 2, person: 1 },
        nextCursor: 'c2',
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'p1', title: 'Dana', object: 'person', via: 'employer', selects: {} },
          { id: 'd2', title: 'Renewal', object: 'deal', via: 'company', selects: {} },
        ],
        totals: { deal: 2, person: 1 },
        nextCursor: null,
      });
    show(record({ counts: { comments: 0, facts: 0, linked: 3, claims: 0 } }), 'linked');
    expect(await screen.findByText('Expansion')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'deals' }).textContent).toContain('Done');
    expect(screen.getByText('Via company')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Dana')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'deals' }).textContent).toContain('Renewal');
    expect(screen.getByRole('list', { name: 'deals' }).textContent).toContain('Expansion');
    expect(linked.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c2' });
  });
});
