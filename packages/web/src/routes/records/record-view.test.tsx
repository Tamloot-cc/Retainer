import { RetainerApiError } from '@retainer/sdk';
import type {
  FieldView,
  ObjectView,
  PresentedRecord,
  SchemaDescription,
  Session,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { pointsAt } from './record-memory.js';
import {
  FieldProperty,
  InlineEditor,
  polymorphicLinksTo,
  RecordView,
  sameValue,
} from './record-view.js';

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const stage: FieldView = {
  type: 'select',
  name: 'stage',
  label: 'Stage',
  description: null,
  settings: {
    options: [
      { value: 'new', label: 'New' },
      { value: 'ready', label: 'Ready' },
      { value: 'won', label: 'Won' },
    ],
  },
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'workspace',
  isProtected: false,
};
const record = {
  id: 'r1',
  updatedAt: '2026-11-03T12:00:00.000Z',
  fields: { stage: 'new' },
} as unknown as PresentedRecord;

function renderEditor(onDone = vi.fn(), field = stage, shown = record) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: {
      objects: [{ nameSingular: 'person', labelPlural: 'People', fields: [] }],
    } as unknown as SchemaDescription,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>
        <InlineEditor record={shown} field={field} onDone={onDone} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('InlineEditor', () => {
  it('ignores picks while a save is in flight, so what shows is what was written', async () => {
    let finish: (value: unknown) => void = () => {};
    const patch = vi
      .spyOn(api, 'patchRecord')
      .mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    const onDone = vi.fn();
    renderEditor(onDone);
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    await userEvent.click(screen.getByRole('option', { name: 'Won' }));
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0]?.[1]).toMatchObject({ values: { stage: 'ready' } });
    expect(screen.getByRole('option', { name: 'Ready' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: 'Won' }).getAttribute('aria-selected')).toBe('false');
    finish({ fields: { stage: 'applied' } });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
  it('closes without writing when the pick is the current value', async () => {
    const patch = vi.spyOn(api, 'patchRecord');
    const onDone = vi.fn();
    renderEditor(onDone);
    await userEvent.click(screen.getByRole('option', { name: 'New' }));
    expect(patch).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe('InlineEditor on a many-to-many set', () => {
  const A = '10000000-0000-4000-8000-00000000000a',
    B = '10000000-0000-4000-8000-00000000000b',
    C = '10000000-0000-4000-8000-00000000000c',
    D = '10000000-0000-4000-8000-00000000000d';
  const contacts: FieldView = {
    ...stage,
    type: 'relation',
    name: 'contacts',
    label: 'Contacts',
    settings: {
      targetObject: 'person',
      inverseField: 'deals',
      relationCardinality: 'many_to_many',
    },
  };
  const deal = {
    id: 'd1',
    updatedAt: '2026-11-03T12:00:00.000Z',
    fields: { contacts: [B, D] },
    relationReferences: {
      [B]: { id: B, object: 'person', label: 'Bea' },
      [D]: { id: D, object: 'person', label: 'Dee' },
    },
  } as unknown as PresentedRecord;
  const people = () =>
    vi.spyOn(api, 'queryRecords').mockResolvedValue({
      records: [
        { id: A, label: 'Avi' },
        { id: B, label: 'Bea' },
        { id: C, label: 'Cal' },
      ],
      nextCursor: null,
    } as never);
  const selected = (name: string) =>
    screen.getByRole('option', { name }).getAttribute('aria-selected');

  it('adds and removes members, then saves the whole set in ID order when the list is left', async () => {
    people();
    const patch = vi
      .spyOn(api, 'patchRecord')
      .mockResolvedValue({ fields: { contacts: 'applied' } } as never);
    const onDone = vi.fn();
    renderEditor(onDone, contacts, deal);
    await screen.findByRole('option', { name: 'Avi' });
    // A member the search didn't return stays listed, named from the record's references.
    expect(selected('Dee')).toBe('true');
    expect(selected('Bea')).toBe('true');
    expect(selected('Avi')).toBe('false');
    await userEvent.click(screen.getByRole('option', { name: 'Cal' }));
    await userEvent.click(screen.getByRole('option', { name: 'Avi' }));
    await userEvent.click(screen.getByRole('option', { name: 'Bea' }));
    // Picks don't write; leaving the list does.
    expect(patch).not.toHaveBeenCalled();
    expect([selected('Avi'), selected('Bea'), selected('Cal')]).toEqual(['true', 'false', 'true']);
    screen.getByRole('combobox', { name: 'Contacts' }).focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0]?.[1]).toEqual({
      values: { contacts: [A, C, D] },
      expectedUpdatedAt: deal.updatedAt,
    });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('keeps the draft beside a retry when the record changed meanwhile', async () => {
    people();
    vi.spyOn(api, 'patchRecord').mockRejectedValue(
      new RetainerApiError(412, 'precondition_failed', 'stale'),
    );
    const onDone = vi.fn();
    renderEditor(onDone, contacts, { ...deal, relationReferences: undefined } as PresentedRecord);
    await userEvent.click(await screen.findByRole('option', { name: 'Avi' }));
    screen.getByRole('combobox', { name: 'Contacts' }).focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('button', { name: 'Retry with latest version' })).toBeTruthy();
    expect(selected('Avi')).toBe('true');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('treats the same members in another order as no change', () => {
    expect(sameValue(contacts, [D, B], [B, D])).toBe(true);
    expect(sameValue(contacts, [B], [B, D])).toBe(false);
    expect(sameValue(contacts, [], [])).toBe(true);
    // Other fields compare as they are.
    expect(sameValue(stage, null, null)).toBe(true);
    expect(sameValue(stage, 'new', 'ready')).toBe(false);
  });

  it('finds the polymorphic relations that may point at an object', () => {
    const customer: FieldView = {
      ...contacts,
      name: 'customer',
      settings: { targetObjects: ['company', 'person'], relationCardinality: 'many_to_one' },
    };
    const deals = {
      nameSingular: 'deal',
      fields: [contacts, customer, { ...customer, name: 'hidden', isFilterable: false }],
    } as unknown as ObjectView;
    expect(
      polymorphicLinksTo([deals], 'person').map((l) => [l.object.nameSingular, l.field.name]),
    ).toEqual([['deal', 'customer']]);
    expect(polymorphicLinksTo([deals], 'deal')).toEqual([]);
    expect(pointsAt(customer, A)).toEqual({ eq: A });
  });

  it('finds records pointing here with eq on one record and containsAny on a set', () => {
    expect(pointsAt(contacts, A)).toEqual({ containsAny: [A] });
    expect(pointsAt({ ...contacts, settings: { relationCardinality: 'many_to_one' } }, A)).toEqual({
      eq: A,
    });
    expect(
      pointsAt(
        { ...contacts, settings: { relationCardinality: 'many_to_many', isInverse: true } },
        A,
      ),
    ).toEqual({ containsAny: [A] });
  });
});

describe('RecordView events tab', () => {
  const company = {
    nameSingular: 'company',
    labelSingular: 'Company',
    labelPlural: 'Companies',
    class: 'entity',
    fields: [],
  } as unknown as ObjectView;
  const person = {
    nameSingular: 'person',
    labelSingular: 'Person',
    labelPlural: 'People',
    class: 'entity',
    fields: [
      {
        ...stage,
        type: 'relation',
        name: 'company',
        label: 'Employer',
        settings: { targetObject: 'company', rollUpEvents: true },
      },
    ],
  } as unknown as ObjectView;
  const conversation = {
    nameSingular: 'conversation',
    labelSingular: 'Conversation',
    labelPlural: 'Conversations',
    class: 'event',
    fields: [],
  } as unknown as ObjectView;
  const acme = {
    id: 'c1',
    object: 'company',
    label: 'Acme',
    updatedAt: '2026-11-03T12:00:00.000Z',
    fields: {},
  } as unknown as PresentedRecord;

  it('names participants and rollup sources from the page’s references, one request in all', async () => {
    const events = vi.spyOn(api, 'recordEvents').mockResolvedValue({
      items: [
        {
          id: 'e1',
          object: 'conversation',
          event: {
            occurredAt: '2026-10-20T10:00:00.000Z',
            channel: 'email',
            externalId: null,
            title: 'Renewal call',
            summary: null,
            participants: {
              matched: [
                { id: 'l1', handle: 'dana@acme.test', role: null, recordId: 'p1' },
                { id: 'l2', handle: 'gone@acme.test', role: null, recordId: 'p9' },
              ],
              unmatched: [],
            },
            about: [],
          },
          via: { kind: 'rollup', field: 'company', record: 'p1' },
        },
      ],
      nextCursor: null,
      references: { p1: { id: 'p1', object: 'person', label: 'Dana Levi' } },
    } as never);
    const record = vi.spyOn(api, 'record');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              workspace: { id: 'w1' },
              actor: { type: 'agent', id: 'a1' },
              scopes: ['read'],
            } as unknown as Session,
            schema: { objects: [company, person, conversation] } as unknown as SchemaDescription,
          }}
        >
          <RecordView record={acme} requestedId="c1" nav={{ tab: 'events', set: vi.fn() }} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Renewal call')).toBeTruthy();
    expect(screen.getByText('Rolled up via Employer of')).toBeTruthy();
    // The rollup source and the participant: both named from the map.
    expect(screen.getAllByRole('link', { name: 'Dana Levi' })).toHaveLength(2);
    // A participant the map leaves out is unavailable, not fetched.
    expect(screen.getByText('Unavailable record')).toBeTruthy();
    expect(events).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });
});

it('toggles a text field between literal and rendered Markdown without writing', async () => {
  const field = {
    ...stage,
    type: 'text',
    name: 'notes',
    label: 'Notes',
    settings: {},
  } as FieldView;
  const shown = { ...record, fields: { notes: '**שלום**' } };
  const workspace = {
    session: { workspace: { id: 'w1' }, actor: {} },
    schema: { objects: [] },
  } as unknown as { session: Session; schema: SchemaDescription };
  const patch = vi.spyOn(api, 'patchRecord');
  render(
    <WorkspaceContext.Provider value={workspace}>
      <FieldProperty record={shown} field={field} editable={false} onHistory={() => {}} />
    </WorkspaceContext.Provider>,
  );
  expect(screen.getByText('**שלום**')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Render Markdown for Notes' }));
  expect(screen.getByText('שלום').tagName).toBe('STRONG');
  await userEvent.click(screen.getByRole('button', { name: 'Show plain text for Notes' }));
  expect(screen.getByText('**שלום**')).toBeTruthy();
  expect(patch).not.toHaveBeenCalled();
});
