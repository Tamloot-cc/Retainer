import type { FieldView, ObjectView } from '@retainer/shared';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActorBadge, SourceBadge } from '../provenance/index.js';
import { categoryColor, objectColor } from './colors.js';
import { initials, ObjectIcon, RecordAvatar } from './identity.js';
import { recordCategory } from './record-colors.js';

const stage = {
  name: 'stage',
  label: 'Stage',
  type: 'select',
  settings: { options: [{ value: 'qualified', label: 'Qualified' }] },
} as FieldView;
const deal = { nameSingular: 'deal', labelSingular: 'Deal', fields: [stage] } as ObjectView;

describe('record and source identity', () => {
  it('keeps a person’s color across a rename and renders readable initials', () => {
    const view = render(<RecordAvatar id="person-1" name="Alex Morgan" object="person" large />);
    const before = view.container.firstElementChild?.getAttribute('data-color');
    expect(view.container.querySelector('[data-initials="AM"]')).toBeTruthy();
    view.rerender(<RecordAvatar id="person-1" name="Alex Rivera" object="person" />);
    expect(view.container.firstElementChild?.getAttribute('data-color')).toBe(before);
    expect(view.container.querySelector('[data-initials="AR"]')).toBeTruthy();
    expect(initials('  שָׁנִי  כהן ')).toBe('שכ');
    expect(initials('')).toBe('?');
  });

  it('shares object identity between an icon and a record tile', () => {
    const view = render(
      <>
        <ObjectIcon name="company" />
        <RecordAvatar id="c1" name="Acme" object="company" />
      </>,
    );
    const colors = [...view.container.querySelectorAll('[data-color]')].map((node) =>
      node.getAttribute('data-color'),
    );
    expect(colors).toEqual([objectColor('company'), objectColor('company')]);
    expect(view.container.querySelector('[data-initials]')).toBeNull();
  });

  it('uses an event icon even for an event whose name matches a person object', () => {
    const view = render(
      <RecordAvatar id="event-1" name="Meeting" object="person" objectClass="event" />,
    );
    expect(view.container.querySelector('[data-initials]')).toBeNull();
    expect(view.container.querySelector('svg')).toBeTruthy();
  });

  it('preserves actor identity when its display name changes', () => {
    const actor = { type: 'agent' as const, id: 'inbox', name: 'Inbox agent' };
    const view = render(<ActorBadge actor={actor} />);
    const before = view.container.firstElementChild?.getAttribute('data-color');
    view.rerender(<ActorBadge actor={{ ...actor, name: 'Research agent' }} />);
    expect(view.container.firstElementChild?.getAttribute('data-color')).toBe(before);
    expect(view.container.textContent).toContain('Research agent');
    expect(view.container.textContent).toContain('agent');
  });

  it('uses the event object color for source attribution', () => {
    const view = render(<SourceBadge type="meeting" label="Meeting" />);
    expect(view.container.firstElementChild?.getAttribute('data-color')).toBe(
      objectColor('meeting'),
    );
    expect(view.container.textContent).toBe('Meeting');
  });
});

describe('calendar category identity', () => {
  it('matches the select tag’s color and describes the category without inferring status', () => {
    expect(recordCategory(deal, { fields: { stage: 'qualified' } })).toEqual({
      color: categoryColor('qualified'),
      label: 'Stage: Qualified',
    });
  });

  it('uses the next populated select and falls back to object identity for unknown/empty values', () => {
    const second = { ...stage, name: 'segment', label: 'Segment' };
    expect(
      recordCategory(
        { ...deal, fields: [stage, second] },
        { fields: { stage: 'deleted', segment: 'qualified' } },
      ).label,
    ).toBe('Segment: Qualified');
    for (const value of ['deleted', null, undefined]) {
      expect(recordCategory(deal, { fields: { stage: value } })).toEqual({
        color: objectColor('deal'),
        label: 'Deal',
      });
    }
  });
});
