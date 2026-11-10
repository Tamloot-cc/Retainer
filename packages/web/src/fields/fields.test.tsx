import { FIELD_TYPES, type FieldView, validateFieldValue } from '@retainer/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decimalToMicros,
  FieldDisplay,
  FieldInput,
  FieldPicker,
  filterValue,
  microsToDecimal,
  PICKERS,
  pickerFor,
  relationIds,
} from './common.js';
import { fields } from './index.js';

describe('pickers', () => {
  const stage = {
    ...f('select'),
    label: 'Stage',
    settings: {
      options: [
        { value: 'new', label: 'New' },
        { value: 'ready', label: 'Ready' },
      ],
    },
  };
  it('gives every type edited from a list a list, not the form fallback', () => {
    // Relation lists load records through the workspace; its own e2e covers it.
    const types = (Object.keys(PICKERS) as FieldView['type'][]).filter((t) => t !== 'relation');
    expect(types.sort()).toEqual(['boolean', 'multi_select', 'select']);
    for (const type of types) {
      const { unmount } = render(
        <FieldPicker field={{ ...stage, type }} value={null} onChange={vi.fn()} />,
      );
      expect(screen.getByRole('listbox')).toBeTruthy();
      unmount();
    }
  });
  it('picks one option as its badge, or clears a nullable field', async () => {
    const onChange = vi.fn();
    render(<FieldPicker field={stage} value="new" onChange={onChange} />);
    expect(screen.getByRole('option', { name: 'New' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    expect(onChange).toHaveBeenLastCalledWith('ready');
    await userEvent.click(screen.getByRole('option', { name: 'No stage' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it('picks the typed match with Enter, not the clearing choice', async () => {
    const onChange = vi.fn();
    render(
      <FieldPicker field={{ ...stage, label: 'Stage area' }} value="new" onChange={onChange} />,
    );
    // "No stage area" contains the typed text too; it isn't offered once typing.
    await userEvent.type(screen.getByRole('combobox', { name: 'Stage area' }), 'a{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('ready');
  });
  it('toggles options of a multi select as a whole new set', async () => {
    const onChange = vi.fn();
    render(
      <FieldPicker
        field={{ ...stage, type: 'multi_select', label: 'Topics' }}
        value={['new']}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    expect(onChange).toHaveBeenLastCalledWith(['new', 'ready']);
    await userEvent.click(screen.getByRole('option', { name: 'New' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it('answers a boolean with Yes or No', async () => {
    const onChange = vi.fn();
    render(
      <FieldPicker
        field={{ ...f('boolean'), label: 'Active', isNullable: false }}
        value={null}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Yes', 'No']);
    await userEvent.click(screen.getByRole('option', { name: 'No' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('filters a select by several options from a list, not JSON', () => {
    expect(filterValue(stage, 'in', ['new', 'ready'])).toEqual(['new', 'ready']);
    expect(() => filterValue(stage, 'in', [])).toThrow('Choose at least one option');
    expect(() => filterValue(stage, 'in', '')).toThrow('Choose at least one option');
    expect(filterValue(f('text'), 'in', '["a"]')).toEqual(['a']);
  });
});

const f = (type: FieldView['type']): FieldView => ({
  type,
  name: 'value',
  label: 'Value',
  description: null,
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'system',
  isProtected: false,
});
describe('field registry and numeric precision', () => {
  it('covers every field type', () => {
    expect(Object.keys(fields).sort()).toEqual([...FIELD_TYPES].sort());
  });
  it('converts decimal amounts exactly and rejects unsafe values', () => {
    expect(decimalToMicros('0.000001')).toBe(1);
    expect(decimalToMicros('123.456789')).toBe(123456789);
    expect(decimalToMicros('-0.3')).toBe(-300000);
    expect(microsToDecimal(123456789)).toBe('123.456789');
    expect(microsToDecimal(0)).toBe('0');
    expect(() => decimalToMicros('0.0000001')).toThrow();
    expect(() => decimalToMicros('999999999999999999')).toThrow();
  });
  it('round-trips representative values for every type through public validation', () => {
    const values: Record<FieldView['type'], unknown> = {
      text: 'Hello',
      number: 12.5,
      boolean: false,
      date: '2026-11-02',
      date_time: '2026-11-02T12:00:00Z',
      select: 'a',
      multi_select: ['a'],
      money: { amountMicros: 1234567, currency: 'USD' },
      emails: { primary: 'a@test.com', additional: [] },
      phones: { primary: { number: '+972501234567', countryCode: 'IL' }, additional: [] },
      links: { primary: { url: 'https://example.com', label: 'Site' }, additional: [] },
      full_name: { first: 'Dana', last: 'Levi' },
      address: { city: 'Tel Aviv' },
      relation: '10000000-0000-4000-8000-000000000001',
      json: { a: 1 },
    };
    for (const type of FIELD_TYPES) {
      const field = {
        ...f(type),
        settings: {
          options: [{ value: 'a', label: 'A' }],
          relationCardinality: 'many_to_one' as const,
        },
      };
      const value = validateFieldValue(field, values[type]);
      expect(validateFieldValue(field, value)).toEqual(value);
      render(<FieldDisplay field={field} value={value} />);
    }
  });
  it('shows empty and false values distinctly', () => {
    render(<FieldDisplay field={f('boolean')} value={false} />);
    expect(screen.getByRole('img', { name: 'No' })).toBeTruthy();
  });
});
function EmailEditor() {
  const [v, setV] = useState<unknown>({ primary: 'a@test.com', additional: [] });
  return (
    <FieldInput field={{ ...f('emails'), settings: { maxValues: 2 } }} value={v} onChange={setV} />
  );
}
it('edits composite lists as whole values, promotes primary and enforces the cap', async () => {
  const user = userEvent.setup();
  render(<EmailEditor />);
  await user.click(screen.getByRole('button', { name: 'Add email' }));
  await user.type(screen.getByRole('textbox', { name: 'Email 2' }), 'b@test.com');
  expect((screen.getByRole('button', { name: 'Add email' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: 'Set primary' }));
  expect((screen.getByRole('textbox', { name: 'Email 1' }) as HTMLInputElement).value).toBe(
    'b@test.com',
  );
});

describe('many-to-many relations', () => {
  const A = '10000000-0000-4000-8000-00000000000a',
    B = '10000000-0000-4000-8000-00000000000b',
    C = '10000000-0000-4000-8000-00000000000c';
  const contacts: FieldView = {
    ...f('relation'),
    label: 'Contacts',
    settings: { targetObject: 'person', relationCardinality: 'many_to_many' },
  };
  it('edits a set from a list that stays open, and one record from a list that saves', () => {
    expect(pickerFor(contacts)).toBe('many');
    expect(pickerFor({ ...contacts, settings: { relationCardinality: 'many_to_one' } })).toBe(
      'one',
    );
    expect(pickerFor(f('text'))).toBeUndefined();
  });
  it('reads a value as record IDs, whether one, a set or none', () => {
    expect(relationIds([A, B])).toEqual([A, B]);
    expect(relationIds(A)).toEqual([A]);
    expect(relationIds(null)).toEqual([]);
    expect(relationIds('')).toEqual([]);
  });
  it('shows a set in full, or its first two and a count in a list cell', () => {
    const { unmount } = render(<FieldDisplay field={contacts} value={[A, B, C]} />);
    expect(screen.getAllByText('Unavailable reference')).toHaveLength(3);
    unmount();
    render(<FieldDisplay field={contacts} value={[A, B, C]} compact />);
    expect(screen.getAllByText('Unavailable reference')).toHaveLength(2);
    expect(screen.getByText('+1')).toBeTruthy();
  });
  it('shows an empty set as empty', () => {
    render(<FieldDisplay field={contacts} value={[]} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
  it('filters a set by records it holds any or all of, or by being empty', () => {
    expect(filterValue(contacts, 'containsAny', [A, B])).toEqual([A, B]);
    expect(filterValue(contacts, 'containsAll', [A])).toEqual([A]);
    expect(() => filterValue(contacts, 'containsAny', [])).toThrow('Choose at least one record');
    expect(() => filterValue(contacts, 'containsAll', '')).toThrow('Choose at least one record');
    expect(filterValue(contacts, 'isEmpty', true)).toBe(true);
    expect(filterValue(contacts, 'isEmpty', false)).toBe(false);
  });
  it('validates a set the way the server stores it', () => {
    expect(validateFieldValue(contacts, [B, A, B])).toEqual([A, B]);
    expect(() => validateFieldValue(contacts, null)).toThrow();
  });
});

it('treats empty composites as empty without hiding zero or false', () => {
  expect(fields.emails.isEmpty({ primary: null, additional: [] })).toBe(true);
  expect(fields.full_name.isEmpty({ first: '', last: '' })).toBe(true);
  expect(fields.address.isEmpty({})).toBe(true);
  expect(fields.number.isEmpty(0)).toBe(false);
  expect(fields.boolean.isEmpty(false)).toBe(false);
  expect(fields.json.isEmpty({})).toBe(false);
});

describe('list cells', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('fits a list again when only a label it shows changes', () => {
    // A 200px cell; each item is as wide as its text, 10px a character.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { width: (this.textContent ?? '').length * 10 } as DOMRect;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const links = (label: string) => ({
      primary: { url: 'https://docs.example.test', label },
      additional: [{ url: 'https://blog.example.test', label: 'Blog' }],
    });
    const { rerender } = render(<FieldDisplay field={f('links')} value={links('Docs')} compact />);
    expect(screen.getByText('Blog')).toBeTruthy();
    rerender(<FieldDisplay field={f('links')} value={links('Documentation home')} compact />);
    expect(screen.queryByText('Blog')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
  });
});
