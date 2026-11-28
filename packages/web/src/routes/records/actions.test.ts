import type { ExtensionRecordButton } from '@retainer/extension';
import type { FieldView, ObjectView, PresentedRecord, RoutineButton } from '@retainer/shared';
import { describe, expect, it, vi } from 'vitest';
import { type ActionContext, type ActionHost, recordActions } from './actions.js';

const person = {
  nameSingular: 'person',
  labelSingular: 'Person',
  labelPlural: 'People',
  class: 'record',
  fields: [],
} as unknown as ObjectView;
const meeting = {
  ...person,
  nameSingular: 'meeting',
  labelPlural: 'Meetings',
  class: 'event',
} as ObjectView;
const record = (id: string, fields: Record<string, unknown> = {}) =>
  ({ id, object: 'person', label: `Person ${id}`, fields }) as unknown as PresentedRecord;
const event = (id: string) =>
  ({ ...record(id), object: 'meeting', event: { occurredAt: '' } }) as unknown as PresentedRecord;
const field = (name: string, extra: Partial<FieldView> = {}) =>
  ({ name, label: name, type: 'emails', settings: {}, readOnly: false, ...extra }) as FieldView;

const routine = { routineId: 'r1', name: 'Send quote', label: 'Send quote' } as RoutineButton;
const enrich = {
  installationId: 'i1',
  functionId: 'f1',
  label: 'Enrich now',
} as ExtensionRecordButton;

function setup(context: Partial<ActionContext> = {}, openRecord = true) {
  const host: ActionHost = {
    open: vi.fn(),
    openRecord: openRecord ? vi.fn() : undefined,
    runRoutine: vi.fn(),
    runExtension: vi.fn(),
  };
  const ctx: ActionContext = {
    canWrite: true,
    canErase: false,
    routineButtons: [],
    extensionButtons: [],
    pageAddress: (r, isEvent) => `http://x/app/${isEvent ? 'e' : 'r'}/${r.id}`,
    copy: vi.fn(),
    openTab: vi.fn(),
    ...context,
  };
  return { host, ctx };
}
const email = field('email');
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe('recordActions', () => {
  it('lists one record’s actions in group order', () => {
    const { host, ctx } = setup({ routineButtons: [routine], extensionButtons: [enrich] });
    const actions = recordActions({ records: [record('a')], object: person }, host, ctx);
    expect(ids(actions)).toEqual([
      'open',
      'open-tab',
      'copy-link',
      'routine:r1',
      'extension:i1:f1',
      'merge',
      'delete',
    ]);
    expect(actions.map((a) => a.group)).toEqual([
      'open',
      'open',
      'open',
      'run',
      'run',
      'change',
      'danger',
    ]);
  });

  it('offers erase to admins only', () => {
    const { host, ctx } = setup({ canErase: true });
    const actions = recordActions({ records: [record('a')], object: person }, host, ctx);
    expect(ids(actions).at(-1)).toBe('erase');
    const member = setup();
    expect(
      ids(recordActions({ records: [record('a')], object: person }, member.host, member.ctx)),
    ).not.toContain('erase');
  });

  it('never merges an event, and opens its event page', () => {
    const { host, ctx } = setup({ canErase: true, routineButtons: [routine] });
    const actions = recordActions({ records: [event('e')], object: meeting }, host, ctx);
    expect(ids(actions)).toEqual([
      'open',
      'open-tab',
      'copy-link',
      'routine:r1',
      'delete',
      'erase',
    ]);
    actions.find((a) => a.id === 'copy-link')?.run();
    expect(ctx.copy).toHaveBeenCalledWith('http://x/app/e/e');
    actions.find((a) => a.id === 'delete')?.run();
    expect(host.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'delete', isEvent: true }),
    );
  });

  it('acts on two selected records: run each routine, merge, delete both', () => {
    const { host, ctx } = setup({ routineButtons: [routine], extensionButtons: [enrich] });
    const actions = recordActions(
      { records: [record('a'), record('b')], object: person },
      host,
      ctx,
    );
    // No open actions and no extension buttons, which take one record.
    expect(actions.map((a) => a.label)).toEqual([
      'Send quote on 2 people',
      'Merge…',
      'Delete 2 people…',
    ]);
    actions[0]?.run();
    expect(host.runRoutine).toHaveBeenCalledWith(routine, ['a', 'b']);
    actions[1]?.run();
    expect(host.open).toHaveBeenCalledWith({ kind: 'merge', ids: ['a', 'b'] });
    actions[2]?.run();
    expect(host.open).toHaveBeenCalledWith({
      kind: 'bulkDelete',
      ids: ['a', 'b'],
      noun: ['person', 'people'],
    });
  });

  it('merges exactly two: three selected can only run and delete', () => {
    const { host, ctx } = setup({ routineButtons: [routine] });
    const actions = recordActions(
      { records: [record('a'), record('b'), record('c')], object: person },
      host,
      ctx,
    );
    expect(ids(actions)).toEqual(['routine:r1', 'delete']);
    expect(actions[1]?.label).toBe('Delete 3 people…');
  });

  it('leaves a read-only person the open and cell actions', () => {
    const { host, ctx } = setup({
      canWrite: false,
      routineButtons: [routine],
      extensionButtons: [enrich],
    });
    const actions = recordActions(
      { records: [record('a', { email: { primary: 'a@x.co' } })], object: person, field: email },
      host,
      ctx,
    );
    expect(ids(actions)).toEqual(['copy-value', 'field-history', 'open', 'open-tab', 'copy-link']);
  });

  it('puts a cell’s copy and history first', () => {
    const { host, ctx } = setup();
    const actions = recordActions(
      { records: [record('a', { email: { primary: 'a@x.co' } })], object: person, field: email },
      host,
      ctx,
    );
    expect(actions.slice(0, 2).map((a) => a.label)).toEqual(['Copy value', 'History of email']);
    actions[0]?.run();
    expect(ctx.copy).toHaveBeenCalledWith('a@x.co');
    actions[1]?.run();
    expect(host.open).toHaveBeenCalledWith({ kind: 'history', recordId: 'a', field: email });
  });

  it('copies only a value there is, and has no history for an event’s built-in columns', () => {
    const { host, ctx } = setup();
    const empty = recordActions(
      { records: [record('a')], object: person, field: email },
      host,
      ctx,
    );
    expect(ids(empty)).not.toContain('copy-value');
    expect(ids(empty)).toContain('field-history');
    const builtIn = recordActions(
      {
        records: [event('e')],
        object: meeting,
        field: field('channel', { readOnly: true }),
      },
      host,
      ctx,
    );
    expect(ids(builtIn)).not.toContain('field-history');
  });

  it('has no Open where the surface gives none, and nothing without records', () => {
    const { host, ctx } = setup({}, false);
    expect(ids(recordActions({ records: [record('a')], object: person }, host, ctx))).not.toContain(
      'open',
    );
    expect(recordActions({ records: [], object: person }, host, ctx)).toEqual([]);
  });
});
