import type {
  FieldView,
  ObjectView,
  SchemaDescription,
  Session,
  TimelinePage,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { type FieldChangeItem, groupByDay, RecordHistory } from './record-history.js';

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const base = {
  description: null,
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'workspace',
  isProtected: false,
} as const;
const stage: FieldView = {
  ...base,
  type: 'select',
  name: 'stage',
  label: 'Stage',
  settings: {
    options: [
      { value: 'new', label: 'New' },
      { value: 'won', label: 'Won' },
    ],
  },
};
const owner: FieldView = {
  ...base,
  type: 'relation',
  name: 'owner',
  label: 'Account owner',
  settings: { targetObject: 'person', relationCardinality: 'many_to_one', rollUpEvents: true },
};
const people: FieldView = {
  ...base,
  type: 'relation',
  name: 'people',
  label: 'People',
  settings: { targetObject: 'person', inverseField: 'company', isInverse: true },
};
const company = {
  nameSingular: 'company',
  labelSingular: 'Company',
  class: 'entity',
  fields: [stage, owner, people],
} as unknown as ObjectView;
const conversation = {
  nameSingular: 'conversation',
  labelSingular: 'Conversation',
  class: 'event',
  fields: [],
} as unknown as ObjectView;
const A = '10000000-0000-4000-8000-00000000000a';
const lostClaim: FieldChangeItem = {
  kind: 'field_change',
  id: 'a1',
  at: '2026-11-03T12:00:00.000Z',
  field: 'stage',
  value: 'won',
  status: 'superseded',
  current: false,
  actor: { type: 'agent', id: 'scout', name: 'Scout' },
  confidence: 0.6,
  source: {
    id: 'e1',
    type: 'conversation',
    title: 'Renewal call',
    occurredAt: '2026-11-03T12:30:00.000Z',
  },
};
const ownerSet: FieldChangeItem = {
  kind: 'field_change',
  id: 'a2',
  at: '2026-11-02T12:00:00.000Z',
  field: 'owner',
  value: A,
  status: 'active',
  current: true,
  actor: { type: 'user', id: 'maayan', name: 'Maayan' },
  confidence: 1,
  source: null,
  relationReferences: { [A]: { id: A, object: 'person', label: 'Avi Cohen' } },
};
const page = (items: FieldChangeItem[], nextCursor: string | null = null): TimelinePage => ({
  record: 'c1',
  items,
  nextCursor,
});

/** The history with its filter in local state, standing in for the URL. */
function Harness({ initial, recordId = 'c1' }: { initial?: string; recordId?: string }) {
  const [fields, setFields] = useState(initial);
  return (
    <RecordHistory
      recordId={recordId}
      object={company}
      fields={fields}
      onFieldsChange={setFields}
    />
  );
}
function renderHistory(initial?: string, recordId?: string) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects: [company, conversation] } as unknown as SchemaDescription,
  };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider value={workspace}>
        <Harness initial={initial} recordId={recordId} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}
const asked = (fields?: string[], cursor?: string) => ({
  types: ['field_change'],
  ...(fields ? { fields } : {}),
  cursor,
  signal: expect.anything(),
});

afterEach(() => vi.restoreAllMocks());

describe('groupByDay', () => {
  it('groups items by local day in the order given', () => {
    const groups = groupByDay([lostClaim, ownerSet]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a1'], ['a2']]);
  });
});

describe('RecordHistory', () => {
  it('asks only for field changes and shows them with their provenance', async () => {
    const timeline = vi.spyOn(api, 'timeline').mockResolvedValue(page([lostClaim, ownerSet]));
    renderHistory();
    const lost = (await screen.findByText('Stage set to')).closest('li') as HTMLElement;
    expect(timeline).toHaveBeenCalledWith('c1', asked());

    // A claim that isn't the current value says so, and implies no diff.
    expect(within(lost).getByText('Won')).toBeTruthy();
    expect(within(lost).getByText('Not the current value')).toBeTruthy();
    expect(within(lost).getByText('Scout')).toBeTruthy();
    expect(within(lost).getByText('Confidence 60%')).toBeTruthy();
    expect(within(lost).getByRole('link', { name: /Renewal call ·/ })).toBeTruthy();
    expect(lost.textContent).not.toMatch(/changed|from New|previous/i);

    // A relation value is named through the item's references; the current value is unlabelled.
    const current = screen.getByText('Account owner set to').closest('li') as HTMLElement;
    expect(within(current).getByText('Avi Cohen')).toBeTruthy();
    expect(within(current).queryByText('Not the current value')).toBeNull();
    expect(within(current).getByText('Maayan')).toBeTruthy();

    // Two days, and nothing to choose between kinds of item.
    expect(screen.getAllByRole('list', { name: /^History for / })).toHaveLength(2);
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    expect(screen.queryByText('All event types')).toBeNull();
  });

  it('leaves out the event a value came from on that event’s own page', async () => {
    vi.spyOn(api, 'timeline').mockResolvedValue(page([lostClaim]));
    renderHistory(undefined, 'e1');
    const row = (await screen.findByText('Stage set to')).closest('li') as HTMLElement;
    expect(within(row).queryByRole('link', { name: /Renewal call/ })).toBeNull();
  });

  it('names a field the schema no longer has', async () => {
    vi.spyOn(api, 'timeline').mockResolvedValue(page([{ ...ownerSet, field: 'gone', value: 'x' }]));
    renderHistory();
    expect(await screen.findByText('gone set to')).toBeTruthy();
    expect(screen.getByText('"x"')).toBeTruthy();
  });

  it('loads older pages with the cursor and the same filter', async () => {
    const timeline = vi
      .spyOn(api, 'timeline')
      .mockResolvedValueOnce(page([lostClaim], 'cursor-1'))
      .mockResolvedValueOnce(page([ownerSet]));
    renderHistory('stage');
    await screen.findByText('Stage set to');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Account owner set to')).toBeTruthy();
    // The first page stays; nothing more to load.
    expect(screen.getByText('Stage set to')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(timeline.mock.calls.map((c) => c[1])).toEqual([
      asked(['stage']),
      asked(['stage'], 'cursor-1'),
    ]);
  });

  it('starts from the newest page when the filter changes, and clears it', async () => {
    const timeline = vi
      .spyOn(api, 'timeline')
      .mockResolvedValueOnce(page([lostClaim], 'cursor-1'))
      .mockResolvedValueOnce(page([ownerSet]))
      .mockResolvedValue(page([]));
    renderHistory();
    await screen.findByText('Stage set to');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(2));

    // Fields come from the record's own fields, not its inverse relations.
    await userEvent.click(screen.getByRole('button', { name: /^Fields/ }));
    expect(screen.queryByRole('option', { name: 'People' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: 'Stage' }));
    await vi.waitFor(() => expect(timeline.mock.calls.at(-1)?.[1]).toEqual(asked(['stage'])));
    expect(await screen.findByText('Nothing matches these filters')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No changes yet')).toBeTruthy();
    expect(timeline.mock.calls.at(-1)?.[1]).toEqual(asked());
  });
});
