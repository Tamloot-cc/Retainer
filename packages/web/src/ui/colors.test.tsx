import type { FieldView } from '@retainer/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldDisplay, selectOptions } from '../fields/common.js';
import { CATEGORY_COLORS, categoryColor, objectColor } from './colors.js';

const stage = {
  type: 'select',
  name: 'stage',
  label: 'Stage',
  settings: {
    options: [
      { value: 'active', label: 'Active' },
      { value: 'new', label: 'New' },
    ],
  },
} as FieldView;

function colorOf(label: string) {
  return screen.getByText(label).closest('[data-color]')?.getAttribute('data-color');
}

describe('category identity', () => {
  it('keeps the same color across a label change and reordered options', () => {
    const view = render(<FieldDisplay field={stage} value="active" />);
    const before = colorOf('Active');
    const renamed = {
      ...stage,
      settings: {
        options: [
          { value: 'new', label: 'New' },
          { value: 'active', label: 'In progress' },
        ],
      },
    };
    view.rerender(<FieldDisplay field={renamed} value="active" />);
    expect(colorOf('In progress')).toBe(before);
    expect(before).toBe(categoryColor('active'));
  });

  it('uses the same color in select display and its picker', () => {
    const view = render(<FieldDisplay field={stage} value="active" />);
    const displayColor = colorOf('Active');
    const option = selectOptions(stage).find((candidate) => candidate.value === 'active');
    view.rerender(option?.content);
    expect(colorOf('Active')).toBe(displayColor);
  });

  it('shares colors with multi-select and leaves unknown values neutral', () => {
    render(
      <FieldDisplay field={{ ...stage, type: 'multi_select' }} value={['active', 'retired']} />,
    );
    expect(colorOf('Active')).toBe(categoryColor('active'));
    expect(colorOf('retired')).toBeUndefined();
  });

  it('retains readable unknown single-select values', () => {
    render(<FieldDisplay field={stage} value="retired" />);
    expect(screen.getByText('retired')).toBeTruthy();
    expect(colorOf('retired')).toBeUndefined();
  });

  it('supports arbitrary object API names, including inherited property names', () => {
    expect(objectColor('person')).toBe('forest');
    expect(objectColor('company')).toBe('teal');
    expect(objectColor('deal')).toBe('coral');
    for (const name of ['constructor', '__proto__', 'custom_object', '', 'לקוח']) {
      expect(CATEGORY_COLORS).toContain(objectColor(name));
      expect(objectColor(name)).toBe(objectColor(name));
    }
  });
});
