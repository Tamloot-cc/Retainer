import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Checkbox, Radio, Switch } from './choice.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('Checkbox, Radio and Switch', () => {
  it('names the control by its label and describes it by its description', () => {
    render(
      <Checkbox
        label="This agent works for me"
        description="It can read and write your personal memory."
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'This agent works for me' });
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'It can read and write your personal memory.',
    );
  });

  it('keeps a description passed by the screen next to its own', () => {
    render(
      <>
        <p id="terms">The terms</p>
        <Checkbox label="I agree" description="Required" aria-describedby="terms" />
      </>,
    );
    const ids = screen.getByRole('checkbox', { name: 'I agree' }).getAttribute('aria-describedby');
    expect(ids?.split(' ')).toContain('terms');
    expect(ids?.split(' ')).toHaveLength(2);
  });

  it('toggles from anywhere on the row', async () => {
    render(<Checkbox label="Share" description="Shared with members" variant="card" />);
    const box = screen.getByRole('checkbox', { name: 'Share' }) as HTMLInputElement;
    await userEvent.click(screen.getByText('Shared with members'));
    expect(box.checked).toBe(true);
  });

  it('tops the row, so the control margin lines it up with the first line of the label', () => {
    render(<Checkbox label="Shown" />);
    const box = screen.getByRole('checkbox', { name: 'Shown' });
    expect(box.className).toBe('ui-checkbox');
    expect(box.parentElement?.classList.contains('items-start')).toBe(true);
  });

  it('stands alone without a label, named by aria-label', () => {
    const { container } = render(<Checkbox aria-label="Select all rows" />);
    expect(container.firstElementChild?.tagName).toBe('INPUT');
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toBeTruthy();
  });

  it('lets an aria-label name a switch whose label shows its state', () => {
    render(<Switch aria-label="Roll up events" label="Off" />);
    expect(screen.getByRole('switch', { name: 'Roll up events' })).toBeTruthy();
  });

  it('draws radios and switches with their own styles', () => {
    render(
      <>
        <Radio name="workspace" label="One" />
        <Switch label="Two" />
      </>,
    );
    expect(screen.getByRole('radio', { name: 'One' }).className).toBe('ui-radio');
    expect(screen.getByRole('switch', { name: 'Two' }).className).toBe('ui-switch');
  });
});

describe('screens', () => {
  it('draw checkboxes, radios and switches only through ui/choice.tsx', () => {
    const own = /type=["'{]+(?:checkbox|radio)\b|\bui-(?:checkbox|radio|switch)\b/;
    const offenders = sources(src)
      .filter((path) => !path.endsWith(join('ui', 'choice.tsx')))
      .filter((path) => own.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path));
    expect(offenders).toEqual([]);
  });
});
