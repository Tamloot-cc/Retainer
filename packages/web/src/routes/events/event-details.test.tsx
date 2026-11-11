import type { EventDetails, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { AddAbout, EventDetailsView, ViaLabel } from './event-details.js';

const conversation = {
  nameSingular: 'conversation',
  class: 'event',
  fields: [{ name: 'deal', label: 'Deal' }],
} as unknown as ObjectView;
const company = {
  nameSingular: 'company',
  class: 'entity',
  fields: [{ name: 'people', label: 'People' }],
} as unknown as ObjectView;
// Person → Employer points at a company and rolls its events up to it.
const person = {
  nameSingular: 'person',
  class: 'entity',
  fields: [
    {
      name: 'company',
      label: 'Employer',
      type: 'relation',
      settings: { targetObject: 'company', rollUpEvents: true },
    },
  ],
} as unknown as ObjectView;

function renderIn(
  children: ReactNode,
  source: Record<string, unknown> = {},
  extra: ObjectView[] = [],
) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects: [conversation, company, person, ...extra] } as unknown as SchemaDescription,
  };
  // Without a references map, record labels are fetched per link; answer them without a server.
  vi.spyOn(api, 'record').mockResolvedValue({ id: 'r', label: 'Dana Levi', ...source } as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

afterEach(() => vi.restoreAllMocks());

describe('ViaLabel', () => {
  it('names how the event is attached, using field labels', () => {
    renderIn(
      <>
        <ViaLabel via={{ kind: 'participant' }} />
        <ViaLabel via={{ kind: 'about' }} />
        <ViaLabel via={{ kind: 'field', field: 'deal' }} eventObject={conversation} />
        <ViaLabel via={{ kind: 'field', field: 'renamedAway' }} eventObject={conversation} />
      </>,
    );
    expect(screen.getByText('Participant')).toBeTruthy();
    expect(screen.getByText('About')).toBeTruthy();
    expect(screen.getByText('Via field Deal')).toBeTruthy();
    expect(screen.getByText('Via field renamedAway')).toBeTruthy();
  });

  it('reads a rollup as a sentence linking the record it came from, not a badge', async () => {
    renderIn(
      <ViaLabel via={{ kind: 'rollup', field: 'company', record: 'p1' }} recordObject={company} />,
      { object: 'person' },
    );
    expect(await screen.findByRole('link', { name: 'Dana Levi' })).toBeTruthy();
    const sentence = screen.getByText('Rolled up via Employer of');
    // Unlike direct attachments, no badge.
    expect(sentence.closest('.border')).toBeNull();
    expect(api.record).toHaveBeenCalledWith('p1', [], expect.anything());
  });

  it('names a rollup from the page’s references without fetching the source', () => {
    renderIn(
      <ViaLabel
        via={{ kind: 'rollup', field: 'company', record: 'p1' }}
        recordObject={company}
        references={{ p1: { id: 'p1', object: 'person', label: 'Dana Levi' } }}
      />,
    );
    expect(screen.getByText('Rolled up via Employer of')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dana Levi' })).toBeTruthy();
    expect(api.record).not.toHaveBeenCalled();
  });

  it('names the field from the source’s object, not by guessing from its name', () => {
    // Two owning `company` relations point at companies: a guess would give up.
    const vendor = {
      nameSingular: 'vendor',
      class: 'entity',
      fields: [
        {
          name: 'company',
          label: 'Parent',
          type: 'relation',
          settings: { targetObject: 'company' },
        },
      ],
    } as unknown as ObjectView;
    renderIn(
      <ViaLabel
        via={{ kind: 'rollup', field: 'company', record: 'v1' }}
        recordObject={company}
        references={{ v1: { id: 'v1', object: 'vendor', label: 'Supplier' } }}
      />,
      {},
      [vendor],
    );
    expect(screen.getByText('Rolled up via Parent of')).toBeTruthy();
  });

  it('guesses the field and shows the source unavailable when the map lacks it', () => {
    renderIn(
      <ViaLabel
        via={{ kind: 'rollup', field: 'company', record: 'gone' }}
        recordObject={company}
        references={{}}
      />,
    );
    expect(screen.getByText('Rolled up via Employer of')).toBeTruthy();
    expect(screen.getByText('Unavailable record')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(api.record).not.toHaveBeenCalled();
  });

  it('without a references map, guesses the source field until the source record loads', async () => {
    renderIn(
      <>
        <ViaLabel via={{ kind: 'rollup', field: 'company', record: 'p1' }} recordObject={company} />
        <ViaLabel via={{ kind: 'rollup', field: 'gone', record: 'p2' }} recordObject={company} />
      </>,
    );
    expect(screen.getByText('Rolled up via Employer of')).toBeTruthy();
    // A field the schema no longer has keeps its API name.
    expect(screen.getByText('Rolled up via gone of')).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Dana Levi' })).toHaveLength(2),
    );
  });
});

const event: EventDetails = {
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  externalId: null,
  title: 'Renewal call',
  summary: null,
  participants: {
    matched: [{ id: 'l1', handle: 'dana@acme.test', role: 'host', recordId: 'p1' }],
    unmatched: [{ id: 'l2', handle: '+15550100', role: null, reason: 'phone_only' }],
  },
  about: [],
};

describe('EventDetailsView', () => {
  it('explains superseded provider evidence and keeps its participants immutable', async () => {
    renderIn(
      <EventDetailsView
        id="e1"
        event={{
          ...event,
          source: { sourceItemId: 's1', revisionId: 'v1', current: false, previousEventId: null },
        }}
        editable
      />,
    );
    expect(screen.getByText(/This provider revision was superseded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add participant…' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });
  it('shows unmatched reasons and erased identity, read-only without write access', async () => {
    renderIn(<EventDetailsView id="e1" event={event} editable={false} />);
    expect(screen.getByText('Phone only')).toBeTruthy();
    expect(screen.getAllByText('Erased for privacy')).toHaveLength(2);
    expect(await screen.findByRole('link', { name: 'Dana Levi' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add participant…' })).toBeNull();
  });

  it('still shows an about link to an event from before C4, and lets it be removed', async () => {
    const remove = vi.spyOn(api, 'removeAbout').mockResolvedValue({} as never);
    renderIn(<EventDetailsView id="e1" event={{ ...event, about: ['e9'] }} editable />);
    expect(screen.queryByText('Not about any record')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove about record' }));
    expect(remove).toHaveBeenCalledWith('e1', 'e9');
  });

  it('removes a participant by its link ID', async () => {
    const remove = vi.spyOn(api, 'removeParticipant').mockResolvedValue({} as never);
    renderIn(<EventDetailsView id="e1" event={event} editable />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove +15550100' }));
    expect(remove).toHaveBeenCalledWith('e1', 'l2');
  });

  it('adds a participant by handle and role', async () => {
    const add = vi.spyOn(api, 'addEventLinks').mockResolvedValue({} as never);
    renderIn(<EventDetailsView id="e1" event={event} editable />);
    await userEvent.click(screen.getByRole('button', { name: 'Add participant…' }));
    await userEvent.type(screen.getByLabelText('Participant email or phone'), 'avi@acme.test');
    await userEvent.type(screen.getByLabelText('Participant role'), 'guest');
    await userEvent.click(screen.getByRole('button', { name: 'Add participant' }));
    expect(add).toHaveBeenCalledWith('e1', {
      participants: [{ handle: 'avi@acme.test', role: 'guest' }],
    });
  });
});

describe('AddAbout', () => {
  it('offers entities only, never an event (C4)', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({
      records: [{ id: 'c1', object: 'company', label: 'Acme', match: 'text' }],
      facts: [],
      events: [
        {
          id: 'e1',
          type: 'conversation',
          occurredAt: '',
          title: 'Kickoff',
          summary: null,
          records: [],
        },
        {
          id: 'e0',
          type: 'conversation',
          occurredAt: '',
          title: 'This one',
          summary: null,
          records: [],
        },
      ],
    });
    const onAdd = vi.fn(async () => true);
    renderIn(<AddAbout busy={false} exclude={['e0']} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add record…' }));
    await userEvent.type(screen.getByLabelText('Find a record'), 'ki');
    await userEvent.click(await screen.findByText('Acme'));
    expect(onAdd).toHaveBeenCalledWith('c1');
    expect(screen.queryByText('Kickoff')).toBeNull();
    expect(screen.queryByText('This one')).toBeNull();
  });
});
