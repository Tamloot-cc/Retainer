import {
  type AggregateOp,
  aggregateOps,
  type CreateViewInput,
  type ObjectView,
  SAVED_VIEW_KINDS,
  type SavedView,
  type SavedViewKind,
  type SavedViewVisibility,
  sameActor,
  type UpdateViewInput,
} from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronDown,
  Lock,
  type LucideIcon,
  Plus,
  Settings2,
  SlidersHorizontal,
  SquareKanban,
  Table2,
  Trash2,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import {
  Button,
  Checkbox,
  Dialog,
  Form,
  FormField,
  IconLabel,
  Input,
  Inset,
  Menu,
  MenuAction,
  MenuChoice,
  MenuChoices,
  MenuItem,
  MenuLabel,
  MenuList,
  MenuSeparator,
  Muted,
  Notice,
  PanelBody,
  PanelHeader,
  Popover,
  Row,
  Segmented,
  SelectMenu,
  Textarea,
  Truncate,
} from '../../ui/index.js';
import type { ColumnPrefs } from './list-state.js';
import { aggregateLabel } from './list-state.js';
import {
  applyChange,
  boardGroups,
  type FieldLayout,
  KIND_LABELS,
  LAYOUT_FIELDS,
  layoutFields,
  toggleHidden,
  ViewSaves,
  viewsKey,
} from './views-state.js';

export const KIND_ICONS: Record<SavedViewKind, LucideIcon> = {
  table: Table2,
  board: SquareKanban,
  calendar: CalendarDays,
};
const allLabel = (object: ObjectView) => `All ${object.labelPlural.toLowerCase()}`;

/** Puts what the server returned into the object's cached list of views. */
function useUpdateViews(object: ObjectView) {
  const client = useQueryClient();
  const { session } = useWorkspace();
  return (update: (views: SavedView[]) => SavedView[]) =>
    client.setQueryData<{ views: SavedView[] }>(
      viewsKey(session.workspace.id, object.nameSingular),
      (old) => old && { views: update(old.views) },
    );
}

/** Saves in flight per view, from every place that changes one. */
const inFlight = new Map<string, ViewSaves>();

/**
 * Every change to a saved view goes through here: it shows at once, and the
 * server's copy replaces it once that copy is known to be the final one
 * (`ViewSaves`). Throws what the save threw.
 */
export function useSaveView(object: ObjectView) {
  const client = useQueryClient();
  const { session } = useWorkspace();
  const workspace = session.workspace.id;
  const objectName = object.nameSingular;
  return useCallback(
    async (id: string, change: UpdateViewInput): Promise<SavedView> => {
      const key = viewsKey(workspace, objectName);
      const replace = (update: (v: SavedView) => SavedView) =>
        client.setQueryData<{ views: SavedView[] }>(
          key,
          (old) => old && { views: old.views.map((v) => (v.id === id ? update(v) : v)) },
        );
      replace((v) => applyChange(v, change));
      const saves = inFlight.get(id) ?? new ViewSaves();
      inFlight.set(id, saves);
      saves.start();
      let updated: SavedView | undefined;
      try {
        updated = await api.updateView(id, change);
        return updated;
      } finally {
        const next = saves.settle(!!updated);
        if (next !== 'wait') inFlight.delete(id);
        const reply = updated;
        if (next === 'use' && reply) replace(() => reply);
        else if (next === 'refetch') void client.invalidateQueries({ queryKey: key });
      }
    },
    [client, workspace, objectName],
  );
}

/** The current view's name; opens the list of views and what can be done with them. */
export function ViewSwitcher({
  object,
  views,
  current,
  writable,
  onSelect,
  onNew,
  onEdit,
  onEditAgent,
  onDelete,
}: {
  object: ObjectView;
  views: SavedView[];
  current: SavedView | undefined;
  writable: boolean;
  onSelect: (id: string | undefined) => void;
  onNew: () => void;
  onEdit: () => void;
  onEditAgent?: () => void;
  onDelete: () => void;
}) {
  const Icon = current ? KIND_ICONS[current.kind] : Table2;
  return (
    <Menu
      label="Views"
      trigger={
        <Button size="small" aria-label={`View: ${current?.name ?? allLabel(object)}`}>
          <Icon size={14} />
          <Truncate>{current?.name ?? allLabel(object)}</Truncate>
          <ChevronDown size={14} />
        </Button>
      }
    >
      <MenuChoices value={current?.id ?? ''} onChange={(id) => onSelect(id || undefined)}>
        <MenuChoice value="">
          <IconLabel icon={Table2}>{allLabel(object)}</IconLabel>
        </MenuChoice>
        {views.map((v) => (
          <MenuChoice
            key={v.id}
            value={v.id}
            end={
              v.visibility === 'private' ? (
                <Lock size={12} role="img" aria-label="Only you" />
              ) : undefined
            }
          >
            <div className="min-w-0">
              <IconLabel icon={KIND_ICONS[v.kind]}>{v.name}</IconLabel>
              {v.description && (
                <p className="truncate pl-6 text-xs text-muted-foreground">{v.description}</p>
              )}
            </div>
          </MenuChoice>
        ))}
      </MenuChoices>
      {onEditAgent && (
        <>
          <MenuSeparator />
          <MenuAction onSelect={onEditAgent}>Edit with the agent</MenuAction>
        </>
      )}
      {writable ? (
        <>
          <MenuSeparator />
          <MenuAction onSelect={onNew}>
            <Plus size={14} />
            New view…
          </MenuAction>
          {current ? (
            <>
              <MenuAction onSelect={onEdit}>
                <Settings2 size={14} />
                Edit view…
              </MenuAction>
              <MenuAction destructive onSelect={onDelete}>
                <Trash2 size={14} />
                Delete view…
              </MenuAction>
            </>
          ) : null}
        </>
      ) : null}
    </Menu>
  );
}

/** A field to group a board by, or to place a calendar by. */
export function FieldChoice({
  object,
  kind,
  value,
  onChange,
}: {
  object: ObjectView;
  kind: FieldLayout;
  value: string;
  onChange: (name: string) => void;
}) {
  const options = layoutFields(object, kind).map((f) => ({
    value: f.name,
    label: f.label,
    content: <IconLabel icon={fields[f.type].icon}>{f.label}</IconLabel>,
  }));
  return (
    <SelectMenu
      label={LAYOUT_FIELDS[kind].label}
      fill
      value={value || null}
      placeholder="Choose a field"
      options={options}
      onChange={onChange}
    />
  );
}

/** A board or calendar without its field (never set, or removed): says so and offers one. */
export function MissingLayoutField({
  object,
  view,
  kind,
  writable,
  onChoose,
}: {
  object: ObjectView;
  view: SavedView;
  kind: FieldLayout;
  writable: boolean;
  onChoose: (field: string) => void;
}) {
  const layout = LAYOUT_FIELDS[kind];
  return (
    <Inset>
      <Notice>
        {view[layout.setting] === null ? layout.removed : ''}
        {layout.prompt}
      </Notice>
      {writable ? <FieldChoice object={object} kind={kind} value="" onChange={onChoose} /> : null}
    </Inset>
  );
}

/**
 * Creates a view from what the list shows now (filter, sort, columns), or
 * edits a view's name, layout, field and who can see it.
 */
export function ViewDialog({
  object,
  view,
  base,
  onClose,
  onSaved,
}: {
  object: ObjectView;
  /** The view to edit; without it, a new one is made. */
  view?: SavedView;
  /** What a new view starts with. */
  base: { filter?: Record<string, unknown>; sort?: CreateViewInput['sort']; columns?: ColumnPrefs };
  onClose: () => void;
  onSaved: (view: SavedView) => void;
}) {
  const { session } = useWorkspace();
  const updateViews = useUpdateViews(object);
  const saveView = useSaveView(object);
  const [description, setDescription] = useState(view?.description ?? '');
  const [name, setName] = useState(view?.name ?? ''),
    [kind, setKind] = useState<SavedViewKind>(view?.kind ?? 'table'),
    // The field each layout would use, kept while switching between them.
    [picked, setPicked] = useState<Record<FieldLayout, string>>(() => {
      const boardFields = layoutFields(object, 'board');
      return {
        board:
          boardFields.find((field) => field.name === view?.groupBy)?.name ??
          boardFields[0]?.name ??
          '',
        calendar: view?.dateField ?? layoutFields(object, 'calendar')[0]?.name ?? '',
      };
    }),
    [visibility, setVisibility] = useState<SavedViewVisibility>(view?.visibility ?? 'workspace'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const ownsIt = !view || sameActor(view.createdBy, session.actor);
  const fieldKind = kind === 'table' ? undefined : kind;
  const layout = fieldKind && LAYOUT_FIELDS[fieldKind];
  const candidates = fieldKind ? layoutFields(object, fieldKind) : [];
  const missing =
    fieldKind && layout && !picked[fieldKind]
      ? candidates.length
        ? layout.choose
        : layout.none(object.labelPlural)
      : '';

  async function save() {
    if (busy || missing || !name.trim()) return;
    setBusy(true);
    setError('');
    const shape = {
      kind,
      ...(fieldKind && layout ? { [layout.setting]: picked[fieldKind] } : {}),
    };
    try {
      if (view) {
        onSaved(
          await saveView(view.id, {
            name: name.trim(),
            description: description.trim() || null,
            ...shape,
            ...(view.kind === 'board' && kind === 'table' ? { groupBy: null } : {}),
            // Hidden columns belong to the field they were hidden under.
            ...(kind === 'board' && picked.board !== view.groupBy ? { hiddenGroups: null } : {}),
            ...(ownsIt && visibility !== view.visibility ? { visibility } : {}),
          }),
        );
        return;
      }
      const created = await api.createView(object.nameSingular, {
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        ...shape,
        ...(base.filter ? { filter: base.filter } : {}),
        ...(base.sort?.length ? { sort: base.sort } : {}),
        ...(base.columns ? { columns: base.columns } : {}),
      });
      updateViews((views) => [...views, created]);
      onSaved(created);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={view ? 'Edit view' : 'New view'}
      description={
        view
          ? undefined
          : 'Saves the filter, sort and columns on screen now, so anyone can come back to them.'
      }
    >
      <Form onSubmit={() => void save()} autoFocus>
        <FormField label="Name">
          <Input
            aria-label="Name"
            value={name}
            maxLength={100}
            placeholder={`Open ${object.labelPlural.toLowerCase()}`}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label="Description">
          <Textarea
            aria-label="Description"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        <FormField label="Layout">
          <Segmented
            label="Layout"
            value={kind}
            options={SAVED_VIEW_KINDS.map((k) => {
              const Icon = KIND_ICONS[k];
              return { value: k, label: KIND_LABELS[k], icon: <Icon size={13} /> };
            })}
            onChange={setKind}
          />
        </FormField>
        {fieldKind && layout ? (
          <FormField
            label={layout.label}
            hint={layout.hint}
            error={!candidates.length ? missing : undefined}
          >
            {candidates.length ? (
              <FieldChoice
                object={object}
                kind={fieldKind}
                value={picked[fieldKind]}
                onChange={(field) => setPicked((p) => ({ ...p, [fieldKind]: field }))}
              />
            ) : null}
          </FormField>
        ) : null}
        <FormField
          label="Who can see it"
          hint={ownsIt ? undefined : 'Only the person who made this view can change this'}
        >
          {ownsIt ? (
            <Segmented
              label="Who can see it"
              value={visibility}
              options={[
                { value: 'workspace', label: 'Everyone in the workspace' },
                { value: 'private', label: 'Only me', icon: <Lock size={12} /> },
              ]}
              onChange={setVisibility}
            />
          ) : (
            <Muted>
              {visibility === 'private' ? 'Only its creator' : 'Everyone in the workspace'}
            </Muted>
          )}
        </FormField>
        {error ? <Notice error>{error}</Notice> : null}
        <Row>
          <Button type="submit" variant="primary" disabled={busy || !!missing || !name.trim()}>
            {busy ? 'Saving…' : view ? 'Save' : 'Create view'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Form>
    </Dialog>
  );
}

export function DeleteViewDialog({
  object,
  view,
  onClose,
  onDeleted,
}: {
  object: ObjectView;
  view: SavedView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const updateViews = useUpdateViews(object);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api.deleteView(view.id);
      updateViews((views) => views.filter((v) => v.id !== view.id));
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete “${view.name}”?`}
      description={`The ${object.labelPlural.toLowerCase()} stay as they are; only this view goes${view.visibility === 'workspace' ? ', for everyone in the workspace' : ''}.`}
    >
      {error ? <Notice error>{error}</Notice> : null}
      <Row>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy ? 'Deleting…' : 'Delete view'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </Row>
    </Dialog>
  );
}

/** Ops that read well over a column of numbers, for a board column's header. */
const HEADER_OPS: AggregateOp[] = ['sum', 'avg', 'min', 'max'];

/** A board's or calendar's settings: its field, and for a board its columns and their total. */
export function ViewOptions({
  object,
  view,
  onChange,
}: {
  object: ObjectView;
  view: SavedView;
  onChange: (change: UpdateViewInput) => void;
}) {
  const group = object.fields.find((f) => f.name === view.groupBy);
  // Every column the board has, hidden ones included.
  const columns = group?.type === 'select' ? boardGroups(group) : undefined;
  // The fields that add up: number and money.
  const totals = object.fields
    .filter((f) => aggregateOps(f).includes('sum'))
    .flatMap((f) =>
      HEADER_OPS.map((op) => ({
        value: `${f.name}:${op}`,
        label: `${aggregateLabel(f, op)} of ${f.label}`,
      })),
    );
  return (
    <Popover
      label={`${KIND_LABELS[view.kind]} options`}
      align="end"
      trigger={
        <Button variant="ghost" size="small">
          <SlidersHorizontal size={14} />
          Options
        </Button>
      }
    >
      <PanelHeader title={`${KIND_LABELS[view.kind]} options`} />
      <PanelBody>
        {view.kind === 'board' ? (
          <>
            <FormField label="Group by">
              <FieldChoice
                object={object}
                kind="board"
                value={view.groupBy ?? ''}
                onChange={(groupBy) => onChange({ groupBy, hiddenGroups: null })}
              />
            </FormField>
            <FormField label="Column total">
              <SelectMenu
                label="Column total"
                fill
                value={
                  view.groupAggregate
                    ? `${view.groupAggregate.field}:${view.groupAggregate.op}`
                    : 'none'
                }
                options={[{ value: 'none', label: 'Count only' }, ...totals]}
                onChange={(next) => {
                  if (next === 'none') return onChange({ groupAggregate: null });
                  const [field, op] = next.split(':') as [string, AggregateOp];
                  onChange({ groupAggregate: { field, op } });
                }}
              />
            </FormField>
          </>
        ) : (
          <FormField label="Date field">
            <FieldChoice
              object={object}
              kind="calendar"
              value={view.dateField ?? ''}
              onChange={(dateField) => onChange({ dateField })}
            />
          </FormField>
        )}
      </PanelBody>
      {columns ? (
        <MenuList>
          <MenuLabel>Columns</MenuLabel>
          {columns.map((g) => {
            const shown = !view.hiddenGroups.includes(g.value);
            return (
              <MenuItem key={g.key} muted={!shown}>
                <Checkbox
                  checked={shown}
                  onChange={() =>
                    onChange({ hiddenGroups: toggleHidden(view.hiddenGroups, g.value) })
                  }
                  label={g.label}
                  truncate
                />
              </MenuItem>
            );
          })}
        </MenuList>
      ) : null}
    </Popover>
  );
}
