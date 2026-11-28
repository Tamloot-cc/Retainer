import type { ExtensionRecordButton } from '@retainer/extension';
import type { FieldView, ObjectView, PresentedRecord, RoutineButton } from '@retainer/shared';
import { isInverseRelation, primaryCopyValue } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  Combine,
  Copy,
  ExternalLink,
  History,
  Link2,
  type LucideIcon,
  MoreHorizontal,
  PanelRightOpen,
  Play,
  ShieldX,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Button,
  Menu,
  MenuAction,
  MenuSeparator,
  PointMenu,
  type PointMenuOpening,
  usePointMenu,
} from '../../ui/index.js';
import { isEventColumn } from '../events/event-list.js';
import { ExtensionRunWatch, useExtensionButtons } from '../extensions/record-buttons.js';
import { useRoutineButtons, useRunRoutineButton } from '../routines/record-buttons.js';
import { objectByName, recordTitle, useReport } from '../state.js';
import { MergeDialog, MergePicker } from './merge.js';
import {
  BulkDeleteDialog,
  DeleteDialog,
  dropRecords,
  ForgetDialog,
  plural,
} from './record-actions.js';
import { FieldHistoryDialog } from './record-view.js';

// One list of the actions on records (context-menu spec §2): the record's
// "…" menu, the bar for selected rows and the right-click menu all read it.

/** Groups in the order menus show them, each after a line. */
const ACTION_GROUPS = ['cell', 'open', 'run', 'change', 'danger'] as const;
type ActionGroup = (typeof ACTION_GROUPS)[number];

export type RecordAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  group: ActionGroup;
  destructive?: boolean;
  /** Opens the action's dialog, or starts the run. */
  run: () => void;
};

/** What the actions are for: records of one object, and the cell right-clicked. */
export type ActionTarget = {
  records: PresentedRecord[];
  object: ObjectView | undefined;
  field?: FieldView;
};

/** A dialog an action opens, with its own copy of what it acts on. */
type HostDialog =
  | { kind: 'mergeInto'; record: PresentedRecord }
  | { kind: 'merge'; ids: [string, string] }
  | { kind: 'delete'; record: PresentedRecord; isEvent: boolean }
  | { kind: 'bulkDelete'; ids: string[]; noun: [string, string] }
  | { kind: 'forget'; record: PresentedRecord }
  | { kind: 'history'; recordId: string; field: FieldView };

/** What outlives a menu: its dialogs and the runs it started (spec §2). */
export type ActionHost = {
  open: (dialog: HostDialog) => void;
  /** Opens a record where the surface does (its sheet); none, no Open. */
  openRecord?: (id: string) => void;
  runRoutine: (button: RoutineButton, recordIds: string[]) => void;
  runExtension: (button: ExtensionRecordButton, recordId: string) => void;
};

/** What the actions depend on besides the target: who is asking, and the buttons. */
export type ActionContext = {
  canWrite: boolean;
  canErase: boolean;
  routineButtons: RoutineButton[];
  extensionButtons: ExtensionRecordButton[];
  /** A record's page: its full address. */
  pageAddress: (record: PresentedRecord, isEvent: boolean) => string;
  copy: (text: string) => void;
  openTab: (address: string) => void;
};

/** What records of `object` are called, singular and plural: ['company', 'companies']. */
const nouns = (object: ObjectView | undefined): [string, string] => [
  (object?.labelSingular ?? 'record').toLowerCase(),
  (object?.labelPlural ?? 'records').toLowerCase(),
];
const count = (n: number, object: ObjectView | undefined) => plural(n, ...nouns(object));

/** A field with claims of its own: not an event's built-in column, nor the other side of a relation. */
const hasHistory = (field: FieldView) =>
  !isInverseRelation(field) && !(isEventColumn(field.name) && field.readOnly);

/** The actions on `target`, in menu order (spec §4). */
export function recordActions(
  target: ActionTarget,
  host: ActionHost,
  context: ActionContext,
): RecordAction[] {
  const { records, object, field } = target;
  const [first] = records;
  if (!first) return [];
  const one = records.length === 1 ? first : undefined;
  const isEvent = object?.class === 'event' || records.some((r) => !!r.event);
  const ids = records.map((r) => r.id);
  const actions: RecordAction[] = [];

  if (one && field) {
    const value = primaryCopyValue(field.type, one.fields[field.name]);
    if (value)
      actions.push({
        id: 'copy-value',
        label: 'Copy value',
        icon: Copy,
        group: 'cell',
        run: () => context.copy(value),
      });
    if (hasHistory(field))
      actions.push({
        id: 'field-history',
        label: `History of ${field.label}`,
        icon: History,
        group: 'cell',
        run: () => host.open({ kind: 'history', recordId: one.id, field }),
      });
  }

  if (one) {
    if (host.openRecord) {
      const openRecord = host.openRecord;
      actions.push({
        id: 'open',
        label: 'Open',
        icon: PanelRightOpen,
        group: 'open',
        run: () => openRecord(one.id),
      });
    }
    actions.push(
      {
        id: 'open-tab',
        label: 'Open in new tab',
        icon: ExternalLink,
        group: 'open',
        run: () => context.openTab(context.pageAddress(one, isEvent)),
      },
      {
        id: 'copy-link',
        label: 'Copy link',
        icon: Link2,
        group: 'open',
        run: () => context.copy(context.pageAddress(one, isEvent)),
      },
    );
  }

  if (!context.canWrite) return actions;

  for (const button of context.routineButtons)
    actions.push({
      id: `routine:${button.routineId}`,
      label: one ? button.label : `${button.label} on ${count(records.length, object)}`,
      icon: Play,
      group: 'run',
      run: () => host.runRoutine(button, ids),
    });
  // Extension buttons take one record.
  if (one)
    for (const button of context.extensionButtons)
      actions.push({
        id: `extension:${button.installationId}:${button.functionId}`,
        label: button.label,
        icon: Sparkles,
        group: 'run',
        run: () => host.runExtension(button, one.id),
      });

  if (!isEvent) {
    if (one)
      actions.push({
        id: 'merge',
        label: 'Merge a duplicate…',
        icon: Combine,
        group: 'change',
        run: () => host.open({ kind: 'mergeInto', record: one }),
      });
    else if (records.length === 2)
      actions.push({
        id: 'merge',
        label: 'Merge…',
        icon: Combine,
        group: 'change',
        run: () => host.open({ kind: 'merge', ids: ids as [string, string] }),
      });
  }

  actions.push({
    id: 'delete',
    label: one ? 'Delete…' : `Delete ${count(records.length, object)}…`,
    icon: Trash2,
    group: 'danger',
    destructive: true,
    run: () =>
      one
        ? host.open({ kind: 'delete', record: one, isEvent })
        : host.open({ kind: 'bulkDelete', ids, noun: nouns(object) }),
  });
  if (one && context.canErase)
    actions.push({
      id: 'erase',
      label: 'Erase for privacy…',
      icon: ShieldX,
      group: 'danger',
      destructive: true,
      run: () => host.open({ kind: 'forget', record: one }),
    });
  return actions;
}

/** `recordActions` for this person, with the object's routine and extension buttons. */
export function useRecordActions(target: ActionTarget | null, host: ActionHost): RecordAction[] {
  const { session } = useWorkspace();
  const router = useRouter();
  const objectName = target?.object?.nameSingular ?? target?.records[0]?.object ?? '';
  const routineButtons = useRoutineButtons(objectName, !!target);
  const extensionButtons = useExtensionButtons(objectName, !!target);
  return useMemo(() => {
    if (!target) return [];
    return recordActions(target, host, {
      canWrite: canMutate(session),
      canErase: canMutate(session, 'admin'),
      routineButtons,
      extensionButtons,
      pageAddress: (record, isEvent) => {
        const location = router.buildLocation({
          to: isEvent ? '/e/$id' : '/r/$id',
          params: { id: record.id },
        });
        return new URL(location.publicHref, window.location.origin).href;
      },
      copy: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
      openTab: (address) => window.open(address, '_blank', 'noopener'),
    });
  }, [target, host, session, routineButtons, extensionButtons, router]);
}

/** Actions as menu items, a line between groups; an empty group leaves no line. */
export function RecordActionItems({ actions }: { actions: RecordAction[] }) {
  const groups = ACTION_GROUPS.map((g) => actions.filter((a) => a.group === g)).filter(
    (list) => list.length,
  );
  return groups.map((list, i) => (
    <Fragment key={list[0]?.group}>
      {i ? <MenuSeparator /> : null}
      {list.map((a) => (
        <MenuAction key={a.id} destructive={a.destructive} onSelect={a.run}>
          <a.icon size={14} />
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
        </MenuAction>
      ))}
    </Fragment>
  ));
}

/**
 * Holds what record actions open, so it stays after the menu closes: the
 * dialog, and the extension runs started, each watched until it ends.
 * `onGone` gets the records deleted or erased, before their queries are
 * dropped, so the surface can leave a screen that showed one.
 */
export function useActionHost({
  onGone,
  openRecord,
}: {
  onGone?: (ids: string[]) => void;
  openRecord?: (id: string) => void;
}): { host: ActionHost; element: ReactNode } {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const report = useReport();
  const [dialog, setDialog] = useState<HostDialog | null>(null);
  const [runs, setRuns] = useState<{ key: string; button: ExtensionRecordButton; runId: string }[]>(
    [],
  );
  const routine = useRunRoutineButton();
  const runRoutine = routine.mutate;
  const endRun = useCallback(
    (key: string) => setRuns((list) => list.filter((x) => x.key !== key)),
    [],
  );

  const host = useMemo<ActionHost>(
    () => ({
      open: setDialog,
      openRecord,
      runRoutine: (button, recordIds) => runRoutine({ button, recordIds }),
      runExtension: (button, recordId) => {
        api.runExtensionRecordButton(button, recordId).then(
          ({ id }) => {
            report(`Started “${button.label}” on this record.`);
            setRuns((list) => [
              ...list,
              { key: `${button.installationId}:${id}`, button, runId: id },
            ]);
          },
          (error: Error) => report(`Couldn’t start “${button.label}”. ${error.message}`),
        );
      },
    }),
    [openRecord, runRoutine, report],
  );

  const close = () => setDialog(null);
  const gone = (ids: string[]) => {
    setDialog(null);
    onGone?.(ids);
    dropRecords(client, session.workspace.id, ids);
  };
  const element = (
    <>
      {dialog?.kind === 'mergeInto' ? <MergePicker record={dialog.record} onClose={close} /> : null}
      {dialog?.kind === 'merge' ? <MergeDialog ids={dialog.ids} onClose={close} /> : null}
      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          record={dialog.record}
          isEvent={dialog.isEvent}
          onClose={close}
          onGone={() => gone([dialog.record.id])}
        />
      ) : null}
      {dialog?.kind === 'bulkDelete' ? (
        <BulkDeleteDialog
          ids={dialog.ids}
          noun={dialog.noun}
          onClose={close}
          onDone={(_failed, deleted) => {
            setDialog(null);
            onGone?.(deleted);
          }}
        />
      ) : null}
      {dialog?.kind === 'forget' ? (
        <ForgetDialog
          record={dialog.record}
          onClose={close}
          onGone={() => gone([dialog.record.id])}
        />
      ) : null}
      {dialog?.kind === 'history' ? (
        <FieldHistoryDialog recordId={dialog.recordId} field={dialog.field} onClose={close} />
      ) : null}
      {runs.map((r) => (
        <ExtensionRunWatch
          key={r.key}
          button={r.button}
          runId={r.runId}
          report={report}
          onEnd={endRun}
          runKey={r.key}
        />
      ))}
    </>
  );
  return { host, element };
}

/** The right-click menu for records, at the point `usePointMenu` opened it. */
function RecordContextMenu({
  opening,
  target,
  host,
  onClose,
}: {
  opening: PointMenuOpening | null;
  target: ActionTarget | null;
  host: ActionHost;
  onClose: () => void;
}) {
  if (!opening || !target?.records.length) return null;
  const [first] = target.records;
  const label =
    target.records.length === 1 && first
      ? `Actions for ${recordTitle(first)}`
      : `Actions for ${count(target.records.length, target.object)}`;
  return (
    <PointMenu opening={opening} label={label} onClose={onClose}>
      <ContextMenuItems target={target} host={host} />
    </PointMenu>
  );
}
function ContextMenuItems({ target, host }: { target: ActionTarget; host: ActionHost }) {
  return <RecordActionItems actions={useRecordActions(target, host)} />;
}

/**
 * The record's "…" menu, in the sheet and on the record page: the Change
 * and Danger actions (merge a duplicate in, delete, erase for privacy).
 * `onGone` leaves the screen after the record is deleted or erased;
 * `requestedId` is the ID the screen was opened with, which differs from
 * the record's after a merge.
 */
export function RecordActions({
  record,
  requestedId,
  onGone,
}: {
  record: PresentedRecord;
  requestedId: string;
  onGone: () => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  // Leave first, then the host drops the record's queries and refreshes the rest.
  const { host, element } = useActionHost({
    onGone: () => {
      onGone();
      client.removeQueries({ queryKey: [session.workspace.id, 'record', requestedId] });
    },
  });
  const target = useMemo(
    () => ({ records: [record], object: objectByName(schema, record.object) }),
    [record, schema],
  );
  const actions = useRecordActions(target, host).filter(
    (a) => a.group === 'change' || a.group === 'danger',
  );
  if (!canMutate(session)) return null;
  return (
    <>
      {actions.length ? (
        <Menu
          label="Record actions"
          align="end"
          trigger={
            <Button variant="ghost" size="icon" aria-label="Record actions" title="Record actions">
              <MoreHorizontal size={16} />
            </Button>
          }
        >
          <RecordActionItems actions={actions} />
        </Menu>
      ) : null}
      {element}
    </>
  );
}

/** Where a right-click landed: the record's row, card or entry, and the cell's column. */
type MenuSpot = { id: string; column?: string };
const findSpot = (element: Element): MenuSpot | undefined => {
  // A card being moved (a long press picks it up) has no menu.
  if (element.closest('[data-dragging]')) return undefined;
  const row = element.closest<HTMLElement>('[data-row]')?.dataset.row;
  if (!row) return undefined;
  const column = element.closest<HTMLElement>('[data-column]')?.dataset.column;
  return column ? { id: row, column } : { id: row };
};

/**
 * The right-click menu for a surface of records (spec §3, §5): spread
 * `handlers` on it, render `element`; what it opens lives in `host`. Rows, cards and entries carry
 * `data-row` (the record ID) and cells `data-column` (the field). With
 * `selection`, right-clicking a selected row acts on every selected row,
 * and right-clicking another selects only it.
 */
export function useRecordMenu({
  object,
  lookup,
  selection,
  fieldFor,
  host,
}: {
  object: ObjectView | undefined;
  lookup: (id: string) => PresentedRecord | undefined;
  selection?: { ids: string[]; select: (ids: string[]) => void };
  fieldFor?: (column: string) => FieldView | undefined;
  host: ActionHost;
}) {
  const menu = usePointMenu(findSpot, (spot) => {
    if (selection && !selection.ids.includes(spot.id)) selection.select([spot.id]);
  });
  const spot = menu.opening?.value;
  const selected = selection?.ids;
  const target = useMemo<ActionTarget | null>(() => {
    if (!spot) return null;
    const ids = selected?.includes(spot.id) ? selected : [spot.id];
    const records = ids.map(lookup).filter((r): r is PresentedRecord => !!r);
    const field = records.length === 1 && spot.column ? fieldFor?.(spot.column) : undefined;
    return records.length ? { records, object, field } : null;
  }, [spot, selected, lookup, fieldFor, object]);
  return {
    handlers: menu.handlers,
    element: (
      <RecordContextMenu opening={menu.opening} target={target} host={host} onClose={menu.close} />
    ),
  };
}

/**
 * Finds a record of `object` among the lists already loaded (a board's
 * columns, a calendar's month), for a surface that has no one list of them.
 */
export function useLoadedRecord(object: string) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const workspace = session.workspace.id;
  return useCallback(
    (id: string) => {
      for (const [, data] of client.getQueriesData<unknown>({
        queryKey: [workspace, 'records', object],
      })) {
        const pages =
          data && typeof data === 'object' && 'pages' in data
            ? (data as { pages: unknown[] }).pages
            : [data];
        for (const page of pages) {
          const found = (page as { records?: PresentedRecord[] } | undefined)?.records?.find(
            (r) => r.id === id,
          );
          if (found) return found;
        }
      }
      return undefined;
    },
    [client, workspace, object],
  );
}
