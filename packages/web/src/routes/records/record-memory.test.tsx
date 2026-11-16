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
import {
  defaultMemoryTab,
  MemoryTabs,
  memoryTabs,
  taskLinksTo,
  taskStatusFilter,
  taskStatusSearch,
} from './record-memory.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const relation = (name: string, targets: string[]) =>
  ({
    name,
    label: name,
    type: 'relation',
    isFilterable: true,
    settings: {
      relationCardinality: 'many_to_one',
      ...(targets.length > 1 ? { targetObjects: targets } : { targetObject: targets[0] }),
    },
  }) as unknown as FieldView;

const object = (name: string, extra: Partial<ObjectView> = {}) =>
  ({
    nameSingular: name,
    labelSingular: name,
    labelPlural: `${name}s`,
    class: 'entity',
    fields: [],
    ...extra,
  }) as unknown as ObjectView;

const task = object('task', {
  baseObject: 'task',
  fields: [
    {
      name: 'state',
      baseField: 'taskStatus',
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
    relation('regarding', ['company', 'person']),
  ],
});
const schema = {
  objects: [
    object('company'),
    object('person'),
    object('deal'),
    object('conversation', { class: 'event' }),
    task,
  ],
} as unknown as SchemaDescription;

const labels = (tabs: { label: string }[]) => tabs.map((t) => t.label);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('which tabs a record has', () => {
  const entity = { isEvent: false, hasTasks: true, developer: false };

  it('gives an entity its memory, comments first', () => {
    expect(labels(memoryTabs(entity))).toEqual([
      'Comments',
      'Facts',
      'Activity',
      'History',
      'Tasks',
    ]);
  });

  it('shows Tasks only where a task relation can point, found by role', () => {
    expect(taskLinksTo(schema, 'company').links.map((f) => f.name)).toEqual(['regarding']);
    expect(taskLinksTo(schema, 'deal').links).toEqual([]);
    const renamed = { objects: [{ ...task, nameSingular: 'todo' }] };
    expect(taskLinksTo(renamed, 'person').task?.nameSingular).toBe('todo');
    expect(taskLinksTo(renamed, 'person').status?.name).toBe('state');
    expect(taskLinksTo({ objects: [object('company')] }, 'company').links).toEqual([]);
    expect(labels(memoryTabs({ ...entity, hasTasks: false }))).not.toContain('Tasks');
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
    const counts = { comments: 0, facts: 2, openTasks: 0, claims: 0 };
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
      counts: { comments: 2, facts: 0, openTasks: 3, claims: 9 },
    });
    expect(tabs.map((t) => [t.label, t.count])).toEqual([
      ['Comments', 2],
      ['Facts', undefined],
      ['Activity', undefined],
      ['History', undefined],
      ['Tasks', 3],
    ]);
    expect(
      memoryTabs({
        ...entity,
        isEvent: true,
        counts: { comments: 0, facts: 0, openTasks: 1, claims: 4 },
      }).map((t) => t.count),
    ).toEqual([undefined, 4, undefined]);
  });

  it('opens where people wrote something, then on what agents remember', () => {
    expect(defaultMemoryTab(false)).toBe('facts');
    expect(defaultMemoryTab(false, { comments: 0, facts: 2, openTasks: 0, claims: 0 })).toBe(
      'facts',
    );
    expect(defaultMemoryTab(false, { comments: 1, facts: 2, openTasks: 0, claims: 0 })).toBe(
      'comments',
    );
    expect(defaultMemoryTab(true)).toBe('comments');
  });
});

describe('which tasks the tab shows', () => {
  const options = ['todo', 'in_progress', 'done'];
  const open = ['todo', 'in_progress'];

  it('defaults to not done, so a task with no status still shows', () => {
    expect(taskStatusFilter(options, undefined)).toEqual({
      open,
      chosen: open,
      condition: { neq: 'done' },
      isDefault: true,
    });
  });

  it('goes back to the default when the address names only statuses that are gone', () => {
    expect(taskStatusFilter(options, 'archived').isDefault).toBe(true);
    expect(taskStatusFilter(options, 'archived,done').condition).toEqual({ in: ['done'] });
  });

  it('asks in the options’ order, however the statuses were ticked', () => {
    expect(taskStatusFilter(options, 'done,todo').condition).toEqual({ in: ['todo', 'done'] });
  });

  it('keeps nothing in the address for the default, and `all` when none is chosen', () => {
    expect(taskStatusFilter(options, 'all')).toMatchObject({ chosen: [], condition: null });
    expect(taskStatusSearch(open, [])).toBe('all');
    expect(taskStatusSearch(open, ['in_progress', 'todo'])).toBeUndefined();
    expect(taskStatusSearch(open, ['todo'])).toBe('todo');
    expect(taskStatusSearch(open, ['todo', 'done'])).toBe('todo,done');
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

  /** The tabs, on a workspace whose task object has `taskFields` if given. */
  function show(
    r: PresentedRecord,
    tab?: string,
    { tasks, taskFields, fact }: { tasks?: string; taskFields?: unknown[]; fact?: string } = {},
  ) {
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
            schema: taskFields
              ? ({
                  objects: [object('company'), { ...task, fields: taskFields }],
                } as unknown as SchemaDescription)
              : schema,
          }}
        >
          <MemoryTabs record={r} nav={{ tab, tasks, fact, set }} />
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
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(set).toHaveBeenCalledWith({
      tab: 'history',
      fields: undefined,
      tasks: undefined,
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

  it('reads a task’s status and due date from its role fields, not their names', async () => {
    const status = {
      name: 'state',
      label: 'State',
      baseField: 'taskStatus',
      type: 'select',
      settings: { options: [{ value: 'in_progress', label: 'In progress' }] },
    } as unknown as FieldView;
    vi.spyOn(api, 'queryRecords').mockResolvedValue({
      records: [{ id: 't1', object: 'task', label: 'Send deck', fields: { state: 'in_progress' } }],
      nextCursor: null,
    } as never);
    show(record({}), 'tasks', {
      taskFields: [status, relation('regarding', ['company', 'person'])],
    });
    expect(await screen.findByText('Send deck')).toBeTruthy();
    const row = screen.getByRole('list', { name: 'Tasks' });
    expect(row.textContent).toContain('In progress');
    expect(row.textContent).not.toContain('in_progress');
  });

  describe('Tasks', () => {
    const tasks = (...rows: [string, string, string][]) =>
      vi.spyOn(api, 'queryRecords').mockResolvedValue({
        records: rows.map(([id, label, state]) => ({
          id,
          object: 'task',
          label,
          fields: { state },
        })),
        nextCursor: null,
      } as never);
    const lastQuery = (spy: ReturnType<typeof tasks>) => {
      const call = spy.mock.calls.at(-1);
      if (!call) throw new Error('no query was sent');
      return call[1] as { filter: { and: unknown[] }; sort: unknown };
    };
    it('shows every status but done by default, from the workspace’s own options', async () => {
      const spy = tasks(['t1', 'Send deck', 'todo']);
      const set = show(record({}), 'tasks');
      expect(await screen.findByText('Send deck')).toBeTruthy();
      expect(lastQuery(spy).filter.and[0]).toEqual({ state: { neq: 'done' } });
      const menu = screen.getByRole('button', { name: /^Status/ });
      expect(menu.textContent).toBe('To doIn progressBlocked');
      expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
      await userEvent.click(menu);
      await userEvent.click(screen.getByRole('option', { name: 'Done' }));
      expect(set).toHaveBeenCalledWith({ tasks: 'todo,in_progress,blocked,done' });
    });

    it('asks for the chosen statuses, and for only done tasks latest due first', async () => {
      const due = { name: 'due', baseField: 'taskDueDate', type: 'date', settings: {} };
      const spy = tasks();
      show(record({}), 'tasks', { tasks: 'done', taskFields: [...task.fields, due] });
      expect(await screen.findByText('No tasks with these statuses')).toBeTruthy();
      expect(lastQuery(spy).filter.and[0]).toEqual({ state: { in: ['done'] } });
      expect(lastQuery(spy).sort).toEqual([{ field: 'due', direction: 'desc' }]);
      cleanup();
      show(record({}), 'tasks', { tasks: 'done,in_progress', taskFields: [...task.fields, due] });
      await vi.waitFor(() =>
        expect(lastQuery(spy).filter.and[0]).toEqual({ state: { in: ['in_progress', 'done'] } }),
      );
      expect(lastQuery(spy).sort).toEqual([{ field: 'due', direction: 'asc' }]);
      cleanup();
      show(record({}), 'tasks', { tasks: 'all', taskFields: [...task.fields, due] });
      expect(await screen.findByText('No tasks')).toBeTruthy();
      expect(lastQuery(spy).filter.and).toHaveLength(1);
    });

    it('sets done tasks apart from open ones', async () => {
      tasks(['t1', 'Send deck', 'todo'], ['t2', 'Book room', 'done']);
      show(record({}), 'tasks');
      const open = await screen.findByText('Send deck');
      const done = screen.getByText('Book room');
      expect(open.className).not.toContain('line-through');
      expect(done.className).toContain('line-through');
      const icon = (el: Element) => el.closest('li')?.querySelector('svg')?.getAttribute('class');
      expect(icon(done)).not.toEqual(icon(open));
    });
  });
});
