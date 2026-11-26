import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Markdown } from './markdown.js';

it('renders a Markdown table with column headers inside a focusable scroll region', () => {
  render(
    <Markdown>
      {'| Company | Notes |\n| --- | --- |\n| ברוש | Demo record |\n\n- Follow up'}
    </Markdown>,
  );

  const region = screen.getByRole('region', { name: 'Markdown table' });
  expect(region.tabIndex).toBe(0);

  const table = within(region).getByRole('table');
  const header = within(table).getByRole('columnheader', { name: 'Company' });
  expect(header.getAttribute('scope')).toBe('col');
  expect(header.getAttribute('dir')).toBe('auto');
  expect(within(table).getByRole('cell', { name: 'ברוש' }).getAttribute('dir')).toBe('auto');
  expect(within(region).queryByRole('list')).toBeNull();
  expect(screen.getByRole('listitem').textContent).toBe('Follow up');
});
