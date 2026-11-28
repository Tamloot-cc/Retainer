import type { ObjectView, PresentedRecord, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { ReportContext } from '../state.js';
import { useActionHost, useRecordMenu } from './actions.js';

vi.mock('@tanstack/react-router', async (original) => {
  const { mockRouter } = await import('../extensions/test-router.js');
  return {
    ...(await mockRouter(original)),
    useRouter: () => ({
      buildLocation: ({ to, params }: { to: string; params: { id: string } }) => ({
        publicHref: `/app${to.replace('$id', params.id)}`,
      }),
    }),
  };
});

afterEach(() => vi.restoreAllMocks());

const person = {
  nameSingular: 'person',
  labelSingular: 'Person',
  labelPlural: 'People',
  class: 'record',
  fields: [{ name: 'name', label: 'Name', type: 'text', settings: {} }],
} as unknown as ObjectView;
const records = ['a', 'b', 'c'].map(
  (id) => ({ id, object: 'person', label: `Person ${id}`, fields: {} }) as PresentedRecord,
);

/** A list like the table: rows with a link and an input, and checkbox selection. */
function List({ initial = [] as string[], selectable = true }) {
  const [selected, setSelected] = useState(initial);
  const actions = useActionHost({ openRecord: vi.fn() });
  const menu = useRecordMenu({
    object: person,
    lookup: (id) => records.find((r) => r.id === id),
    selection: selectable ? { ids: selected, select: setSelected } : undefined,
    fieldFor: (column) => person.fields.find((f) => f.name === column),
    host: actions.host,
  });
  return (
    <>
      <p>Outside</p>
      <table {...menu.handlers}>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} data-row={r.id} data-selected={selected.includes(r.id) || undefined}>
              <td data-column="name">
                <a href={`/r/${r.id}`}>{r.label}</a>
                <input aria-label={`Edit ${r.label}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <output>{selected.join(',')}</output>
      {menu.element}
      {actions.element}
    </>
  );
}

function mount(ui: React.ReactNode, { write = true, report = vi.fn() } = {}) {
  vi.spyOn(api, 'routineButtons').mockResolvedValue({ buttons: [] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'u' },
            routinesAvailable: false,
            scopes: write ? ['read', 'write'] : ['read'],
            workspace: { id: 'w' },
          } as unknown as Session,
          schema: { objects: [person] } as unknown as SchemaDescription,
        }}
      >
        <ReportContext.Provider value={report}>{ui}</ReportContext.Provider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  return report;
}
const link = (id: string) => screen.getByRole('link', { name: `Person ${id}` });
const items = () => screen.getAllByRole('menuitem').map((i) => i.textContent);

describe('record right-click menu', () => {
  it('opens on a row, at the pointer, with that record’s actions', async () => {
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [] });
    mount(<List />);
    fireEvent.contextMenu(link('a'), { clientX: 40, clientY: 60 });
    expect(await screen.findByRole('menu', { name: 'Actions for Person a' })).toBeTruthy();
    // The link is in a cell, so the cell's own actions come first.
    expect(items()).toEqual([
      'History of Name',
      'Open',
      'Open in new tab',
      'Copy link',
      'Merge a duplicate…',
      'Delete…',
    ]);
    // A right-clicked unselected row becomes the selection.
    expect(screen.getByRole('status').textContent).toBe('a');
  });

  it('acts on every selected row when a selected one is right-clicked', async () => {
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [] });
    mount(<List initial={['a', 'b', 'c']} />);
    fireEvent.contextMenu(link('b'), { clientX: 40, clientY: 60 });
    expect(await screen.findByRole('menu', { name: 'Actions for 3 people' })).toBeTruthy();
    expect(items()).toEqual(['Delete 3 people…']);
    expect(screen.getByRole('status').textContent).toBe('a,b,c');
  });

  it('selects only an unselected row that is right-clicked', async () => {
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [] });
    mount(<List initial={['a', 'b']} />);
    fireEvent.contextMenu(link('c'), { clientX: 40, clientY: 60 });
    expect(await screen.findByRole('menu', { name: 'Actions for Person c' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('c');
  });

  it('opens from the keyboard on a focused link in a row', async () => {
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [] });
    mount(<List />);
    link('b').focus();
    // What Shift+F10 or the menu key fires: no pointer position.
    fireEvent.contextMenu(link('b'), { clientX: 0, clientY: 0 });
    expect(await screen.findByRole('menu', { name: 'Actions for Person b' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(link('b'));
  });

  it('leaves the browser’s menu outside a record and in an input', () => {
    mount(<List />);
    expect(fireEvent.contextMenu(screen.getByText('Outside'))).toBe(true);
    expect(fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Edit Person a' }))).toBe(
      true,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    // On a record the menu takes over: the event is cancelled.
    expect(fireEvent.contextMenu(link('a'))).toBe(false);
  });

  it('leaves out empty groups and their lines for a read-only person', async () => {
    mount(<List selectable={false} />, { write: false });
    fireEvent.contextMenu(screen.getAllByRole('cell')[0] as HTMLElement, {
      clientX: 10,
      clientY: 10,
    });
    expect(await screen.findByRole('menu')).toBeTruthy();
    // The cell's history, then the open actions; nothing that changes records.
    expect(items()).toEqual(['History of Name', 'Open', 'Open in new tab', 'Copy link']);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('reports an extension run started from the menu after the menu has closed', async () => {
    const button = { installationId: 'i1', functionId: 'f1', label: 'Enrich now' };
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [button] } as never);
    const start = vi.spyOn(api, 'runExtensionRecordButton').mockResolvedValue({ id: 'run-1' });
    vi.spyOn(api, 'extensionRecordButtonRun').mockResolvedValue({
      status: 'succeeded',
      code: null,
    } as never);
    const report = mount(<List />);
    fireEvent.contextMenu(link('a'), { clientX: 40, clientY: 60 });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Enrich now' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(start).toHaveBeenCalledWith(button, 'a');
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('“Enrich now” finished.'));
    expect(report).toHaveBeenCalledWith('Started “Enrich now” on this record.');
  });

  it('opens field history for a right-clicked cell', async () => {
    vi.spyOn(api, 'extensionRecordButtons').mockResolvedValue({ buttons: [] });
    const history = vi.spyOn(api, 'assertions').mockResolvedValue({
      items: [],
      nextCursor: null,
    } as never);
    mount(<List />);
    fireEvent.contextMenu(screen.getAllByRole('cell')[0] as HTMLElement, {
      clientX: 10,
      clientY: 10,
    });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'History of Name' }));
    expect(await screen.findByRole('dialog', { name: 'History of Name' })).toBeTruthy();
    expect(history).toHaveBeenCalledWith('a', expect.objectContaining({ field: 'name' }));
  });
});
