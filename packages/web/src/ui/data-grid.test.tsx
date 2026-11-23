import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditableCell } from './data-grid.js';
import { PropertyEditor } from './property.js';

/** A cell whose editor closes itself on save or cancel, as `InlineEditor` does. */
function Cell({ onSave = vi.fn(), onOutside = vi.fn() }) {
  return (
    <>
      <button type="button">Another cell</button>
      <EditableCell
        label="Stage of Acme"
        editor={(close) => (
          <PropertyEditor
            onSave={() => {
              onSave();
              close();
            }}
            onCancel={close}
            onOutside={() => {
              onOutside();
              close();
            }}
          >
            <input aria-label="Stage" defaultValue="Ready" />
          </PropertyEditor>
        )}
      >
        Ready
      </EditableCell>
    </>
  );
}

describe('EditableCell', () => {
  it('opens from the cell value without opening its row', async () => {
    const onOpenRow = vi.fn();
    const onSave = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: mirrors the grid row click shortcut.
      <div onClick={onOpenRow}>
        <Cell onSave={onSave} />
      </div>,
    );
    await userEvent.click(screen.getByText('Ready', { exact: true }));
    expect(screen.getByRole('textbox', { name: 'Stage' })).toBe(document.activeElement);
    expect(onOpenRow).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Stage' })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('lets the editor decide what a click outside means', async () => {
    const onOutside = vi.fn();
    render(<Cell onOutside={onOutside} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Stage of Acme' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Stage' }));
    await userEvent.click(screen.getByRole('button', { name: 'Another cell' }));
    expect(onOutside).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Stage' })).toBeNull();
  });
  it('closes on the pencil without reopening, and drops the draft on Escape', async () => {
    const onOutside = vi.fn(),
      onSave = vi.fn();
    render(<Cell onOutside={onOutside} onSave={onSave} />);
    const pencil = screen.getByRole('button', { name: 'Edit Stage of Acme' });
    await userEvent.click(pencil);
    await userEvent.click(pencil);
    expect(onOutside).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Stage' })).toBeNull();
    await userEvent.click(pencil);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Stage' })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onOutside).toHaveBeenCalledOnce();
  });
});
