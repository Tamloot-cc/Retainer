import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CalendarEntry } from './calendar.js';

describe('calendar entry accessibility', () => {
  it('announces the category with the title and time, and still opens the record', async () => {
    const onOpen = vi.fn();
    render(
      <CalendarEntry
        id="deal-1"
        day="2026-03-11"
        item={{}}
        title="Acme renewal"
        time="09:00"
        category={{ color: 'coral', label: 'Stage: Qualified' }}
        draggable={false}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Acme renewal, 09:00, Stage: Qualified',
      }),
    );
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('announces a category even when the record has no time', () => {
    render(
      <CalendarEntry
        id="deal-1"
        day="2026-03-11"
        item={{}}
        title="Acme renewal"
        category={{ color: 'coral', label: 'Stage: Qualified' }}
        draggable={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Acme renewal, Stage: Qualified' })).toBeTruthy();
  });

  it('keeps the existing accessible name when there is no category', () => {
    const view = render(
      <CalendarEntry
        id="deal-1"
        day="2026-03-11"
        item={{}}
        title="Acme renewal"
        time="09:00"
        draggable={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Acme renewal, 09:00' })).toBeTruthy();
    view.rerender(
      <CalendarEntry
        id="deal-1"
        day="2026-03-11"
        item={{}}
        title="Acme renewal"
        draggable={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Acme renewal' })).toBeTruthy();
  });
});
