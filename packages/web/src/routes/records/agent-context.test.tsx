import type { ContextPack, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContext } from '../../api/client.js';
import {
  AgentContextView,
  fieldsNotSent,
  largerBudget,
  leftOutLine,
  leftOutSummary,
  sizeLine,
} from './agent-context.js';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: name,
  type: 'text',
  settings: {},
  description: null,
  ...extra,
});
const company = {
  nameSingular: 'company',
  labelSingular: 'Company',
  labelPlural: 'Companies',
  class: 'entity',
  fields: [
    field('name'),
    field('category', { type: 'select' }),
    field('domain'),
    field('employees', { type: 'number' }),
    // Read only: its records come as linked records, so it never counts as unsent.
    field('people', { type: 'relation', settings: { isInverse: true } }),
  ],
} as unknown as ObjectView;
const person = {
  nameSingular: 'person',
  labelSingular: 'Person',
  labelPlural: 'People',
  class: 'entity',
  fields: [],
} as unknown as ObjectView;
const meeting = {
  nameSingular: 'conversation',
  labelSingular: 'Conversation',
  labelPlural: 'Conversations',
  class: 'event',
  fields: [],
} as unknown as ObjectView;
const agent = { type: 'agent', id: 'inbox', name: 'Inbox agent' } as const;

/** A fixed pack: two values, one linked person, one fact, one event, and some left out. */
const pack: ContextPack = {
  record: {
    id: 'c1',
    object: 'company',
    label: 'Attio',
    fields: {
      name: { value: 'Attio', writtenBy: agent, observedAt: '2026-11-01T10:00:00.000Z' },
      category: { value: 'ai_native', writtenBy: agent, observedAt: '2026-11-02T10:00:00.000Z' },
    },
  },
  linkedRecords: [
    {
      object: 'person',
      total: 2,
      items: [
        {
          id: 'p1',
          title: 'Dana Levi',
          via: { field: 'company', on: 'linked' },
          selects: { role: 'buyer' },
        },
      ],
    },
  ],
  facts: [
    {
      id: 'f1',
      content: 'Prefers annual billing.',
      validFrom: '2026-11-03T10:00:00.000Z',
      writtenBy: agent,
      sources: ['e1'],
    },
  ],
  recentEvents: [
    {
      id: 'e1',
      type: 'conversation',
      occurredAt: '2026-11-03T09:00:00.000Z',
      title: 'Pricing call',
      summary: 'Talked about annual billing.',
      via: { kind: 'about' },
    },
  ],
  omitted: { linkedRecords: 0, facts: 0, recentEvents: 1 },
  tokenEstimate: 1922,
};

describe('the agent context helpers', () => {
  it('says what was left out, and nothing when the pack fit', () => {
    expect(leftOutSummary(pack.omitted)).toBe('Left out: 1 event');
    expect(leftOutSummary({ linkedRecords: 3, facts: 1, recentEvents: 2 })).toBe(
      'Left out: 3 linked records, 1 fact, 2 events',
    );
    expect(leftOutSummary({ linkedRecords: 0, facts: 0, recentEvents: 0 })).toBeNull();
    expect(leftOutLine('facts', 2)).toBe('2 facts did not fit');
  });

  it('counts the fields with no value, leaving out inverse relations', () => {
    expect(fieldsNotSent(pack, company)).toBe(2);
    expect(fieldsNotSent(pack, undefined)).toBe(0);
  });

  it('gives the size against the budget, and the next budget up', () => {
    expect(sizeLine(pack, 2000)).toBe('about 1,922 of 2,000 tokens');
    expect(largerBudget(2000)).toBe(8000);
    expect(largerBudget(8000)).toBe(16000);
    expect(largerBudget(16000)).toBeUndefined();
  });
});

describe('the Agent context tab', () => {
  function show(options: { raw?: boolean; budget?: 2000 | 8000 | 16000 } = {}) {
    const onBudget = vi.fn(),
      onRaw = vi.fn();
    render(
      <WorkspaceContext.Provider
        value={{
          session: { workspace: { id: 'w1' } } as unknown as Session,
          schema: { objects: [company, person, meeting] } as unknown as SchemaDescription,
        }}
      >
        <AgentContextView
          pack={pack}
          object={company}
          budget={options.budget ?? 2000}
          onBudget={onBudget}
          raw={options.raw ?? false}
          onRaw={onRaw}
        />
      </WorkspaceContext.Provider>,
    );
    return { onBudget, onRaw };
  }

  it('shows each section in the order the agent receives it, with counts', () => {
    show();
    expect(screen.getByText('What an agent gets when it reads this record')).toBeTruthy();
    expect(screen.getByText('about 1,922 of 2,000 tokens · Left out: 1 event')).toBeTruthy();
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Values', 'Linked records', 'Facts', 'Recent events']);
    // Values as stored, not as people read them.
    expect(screen.getByText('ai_native')).toBeTruthy();
    expect(screen.getByText('category')).toBeTruthy();
    expect(screen.getByText('2 fields have no value and are not sent.')).toBeTruthy();
    // Linked records grouped by object with the group's total.
    expect(screen.getByText('(2)')).toBeTruthy();
    expect(screen.getByText('role: buyer')).toBeTruthy();
    // A fact names its source event by title when the pack holds it.
    const facts = screen.getByRole('list', { name: 'Facts in the pack' });
    expect(within(facts).getByText('Prefers annual billing.')).toBeTruthy();
    expect(within(facts).getByText('Pricing call')).toBeTruthy();
    const events = screen.getByRole('list', { name: 'Events in the pack' });
    expect(within(events).getByText('Pricing call')).toBeTruthy();
    expect(within(events).getByText('About')).toBeTruthy();
  });

  it('ends a section with what did not fit, and raises the budget from there', async () => {
    const { onBudget } = show();
    expect(screen.getByText('1 event did not fit.')).toBeTruthy();
    expect(screen.queryByText(/facts? did not fit/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Raise the budget to 8,000' }));
    expect(onBudget).toHaveBeenCalledWith(8000);
    await userEvent.click(screen.getByRole('button', { name: '16,000' }));
    expect(onBudget).toHaveBeenCalledWith(16000);
  });

  it('offers no larger budget at the largest', () => {
    show({ budget: 16000 });
    expect(screen.getByText('1 event did not fit.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Raise the budget/ })).toBeNull();
  });

  it('shows the JSON as returned when raw', async () => {
    const { onRaw } = show({ raw: true });
    expect(screen.queryByRole('heading', { name: 'Values' })).toBeNull();
    const json = screen.getByLabelText('Agent context JSON');
    expect(JSON.parse(json.textContent ?? '')).toEqual(pack);
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show sections' }));
    expect(onRaw).toHaveBeenCalledWith(false);
  });
});
