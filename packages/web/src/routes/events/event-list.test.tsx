import type { FieldView, ObjectView, PresentedRecord } from '@retainer/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultColumnOrder, resolveColumns } from '../views/list-state.js';
import {
  eventColumnOrder,
  eventListObject,
  eventMedium,
  listFilterOperators,
  occurredCalendar,
  ParticipantsCell,
  withEventValues,
} from './event-list.js';

const field = (name: string, rest: Partial<FieldView> = {}): FieldView => ({
  name,
  label: name,
  type: 'text',
  description: null,
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'system',
  isProtected: false,
  ...rest,
});
const medium = field('medium', {
  type: 'select',
  baseField: 'conversationMedium',
  settings: {
    options: [
      { value: 'meeting', label: 'Meeting' },
      { value: 'call', label: 'Call' },
    ],
  },
});
const conversation = {
  nameSingular: 'conversation',
  namePlural: 'conversations',
  labelSingular: 'Conversation',
  labelPlural: 'Conversations',
  class: 'event',
  baseObject: 'conversation',
  labelField: 'title',
  eventColumns: ['occurredAt', 'channel', 'externalId'],
  fields: [
    field('title', { coreRole: 'title' }),
    field('summary', { coreRole: 'summary' }),
    field('recording', { type: 'links' }),
    medium,
  ],
} as unknown as ObjectView;
const company = {
  nameSingular: 'company',
  class: 'entity',
  labelField: 'name',
  fields: [field('name'), field('domain')],
} as unknown as ObjectView;
const person = { ...company, nameSingular: 'person' } as ObjectView;
const note = {
  ...conversation,
  nameSingular: 'note',
  baseObject: 'note',
  fields: [],
} as unknown as ObjectView;
const schema = { objects: [company, person, conversation, note] };

describe('event type lists', () => {
  it('lead with when it happened and the medium, end with links and source, and hide the summary', () => {
    expect(eventColumnOrder(conversation)).toEqual([
      'occurredAt',
      'medium',
      'recording',
      'participants',
      'about',
      'channel',
    ]);
    // Object lists use it for every event type; entities keep their fields.
    expect(defaultColumnOrder(conversation)).toEqual(eventColumnOrder(conversation));
    expect(defaultColumnOrder(company)).toEqual(['domain']);
  });

  it('list the built-in columns as read-only fields, the title still first', () => {
    const list = eventListObject(conversation, schema);
    const columns = resolveColumns(list, undefined).map((f) => [f.name, f.label]);
    expect(columns).toEqual([
      ['title', 'title'],
      ['occurredAt', 'Occurred'],
      ['medium', 'medium'],
      ['recording', 'recording'],
      ['participants', 'Participants'],
      ['about', 'About'],
      ['channel', 'Source'],
    ]);
    const about = list.fields.find((f) => f.name === 'about');
    expect(about?.readOnly).toBe(true);
    // About and participants name entities only (C4).
    expect(about?.settings.targetObjects).toEqual(['company', 'person']);
    expect(list.fields.find((f) => f.name === 'participants')?.settings.targetObjects).toEqual([
      'company',
      'person',
    ]);
    expect(eventListObject(company, schema)).toBe(company);
  });

  it('read built-in columns from the event, and offer only the operators the query takes', () => {
    const record = {
      id: 'e1',
      fields: { title: 'Kickoff' },
      event: {
        occurredAt: '2026-11-05T10:00:00.000Z',
        channel: 'zoom',
        externalId: 'z-1',
        title: 'Kickoff',
        summary: null,
        participants: {
          matched: [{ id: 'l1', handle: 'a@x.test', role: null, recordId: 'p1' }],
          unmatched: [{ id: 'l2', handle: 'b@x.test', role: null, reason: 'no_match' }],
        },
        about: ['c1'],
      },
    } as unknown as PresentedRecord;
    expect(withEventValues(record).fields).toEqual({
      title: 'Kickoff',
      occurredAt: '2026-11-05T10:00:00.000Z',
      participants: ['p1'],
      about: ['c1'],
      channel: 'zoom',
      externalId: 'z-1',
    });
    const columns = eventListObject(conversation, schema).fields;
    const of = (name: string) =>
      listFilterOperators(columns.find((f) => f.name === name) as FieldView);
    expect(of('channel')).toEqual(['eq', 'neq']);
    expect(of('occurredAt')).toContain('gte');
    expect(of('occurredAt')).not.toContain('isNull');
    expect(of('title')).toContain('contains');
  });

  it('name the medium by its option, and place a calendar by when events happened', () => {
    expect(eventMedium(conversation, { fields: { medium: 'call' } })).toBe('Call');
    expect(eventMedium(conversation, { fields: { medium: null } })).toBeUndefined();
    expect(eventMedium(note, { fields: { medium: 'call' } })).toBeUndefined();
    expect(occurredCalendar(conversation)).toMatchObject({
      kind: 'calendar',
      dateField: 'occurredAt',
    });
    const kind = { ...medium, name: 'kind' };
    const renamed = { ...conversation, fields: [kind] } as ObjectView;
    expect(eventMedium(renamed, { fields: { kind: 'call' } })).toBe('Call');
    const namesake = { ...conversation, fields: [{ ...medium, baseField: undefined }] };
    expect(eventMedium(namesake as ObjectView, { fields: { medium: 'call' } })).toBeUndefined();
  });
});

describe('the participants cell', () => {
  it('fits people and unmatched handles in one list, a person matched twice included', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = {
      id: 'e1',
      fields: {},
      event: {
        participants: {
          // One person, matched by two of their addresses.
          matched: [
            { id: 'l1', handle: 'a@x.test', role: null, recordId: 'p1' },
            { id: 'l2', handle: 'a@y.test', role: null, recordId: 'p1' },
          ],
          unmatched: [{ id: 'l3', handle: 'b@x.test', role: null, reason: 'no_match' }],
        },
      },
    } as unknown as PresentedRecord;
    render(
      <ParticipantsCell record={record} field={field('participants', { type: 'relation' })} />,
    );
    // Before the cell has a width, two items show and the third is counted.
    expect(screen.getAllByText('Unavailable reference')).toHaveLength(2);
    expect(screen.getByText('+1')).toBeTruthy();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
  });
});
