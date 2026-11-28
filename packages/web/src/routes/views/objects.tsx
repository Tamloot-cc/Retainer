import type { ObjectView, QueryInput, RecordPage, UpdateViewInput } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  BookmarkPlus,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Play,
  Plus,
  Save,
  Table2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { pickerFor } from '../../fields/common.js';
import { primaryCopyValue } from '../../fields/copy-value.js';
import { fields } from '../../fields/index.js';
import {
  Button,
  CopyableCell,
  DataGrid,
  DescriptionLine,
  EditableCell,
  Empty,
  FilterChip,
  GridFooter,
  type GridSelection,
  Input,
  Inset,
  Menu,
  Muted,
  Notice,
  ObjectIcon,
  Page,
  RecordAvatar,
  RecordLink,
  Segmented,
  Toolbar,
} from '../../ui/index.js';
import { canStart } from '../agent/chats-search.js';
import { newChat } from '../agent/first-message.js';
import { useRememberCommand } from '../command-recents.js';
import { useAgentDescription, useApiName } from '../developer.js';
import {
  DEFAULT_EVENT_SORT,
  eventListObject,
  LoggedByAgents,
  occurredCalendar,
  ParticipantsCell,
  withEventValues,
} from '../events/event-list.js';
import {
  type RecordAction,
  RecordActionItems,
  useActionHost,
  useLoadedRecord,
  useRecordActions,
  useRecordMenu,
} from '../records/actions.js';
import { CreateRecordDialog } from '../records/create-record.js';
import { InlineEditor, RecordSheet } from '../records/record-view.js';
import { isWritable } from '../records/write-model.js';
import { QueryError, recordTitle, useView } from '../state.js';
import { BoardView } from './board-view.js';
import { CalendarView } from './calendar-view.js';
import { GroupedTable } from './grouped-table.js';
import { rememberView, useLastView } from './last-view.js';
import { ColumnsMenu, FilterMenu, SortMenu } from './list-controls.js';
import {
  addClause,
  type ColumnPrefs,
  defaultColumnOrder,
  defaultColumnWidth,
  describeClause,
  encodeFilter,
  encodeSort,
  type FilterParts,
  isSortable,
  loadColumnPrefs,
  loadRowDensity,
  moveColumn,
  nextSort,
  type PageTrail,
  pageRange,
  parseListSearch,
  recordNextPage,
  resolveColumns,
  saveColumnPrefs,
  saveRowDensity,
  shownColumnPrefs,
} from './list-state.js';
import { describeFilter, SettingsSummary } from './settings-summary.js';
import {
  DeleteViewDialog,
  useSaveView,
  ViewDialog,
  ViewOptions,
  ViewSwitcher,
} from './view-bar.js';
import { parseViewDraft, viewSettings } from './view-draft.js';
import {
  applyChange,
  changesToSave,
  effectiveSearch,
  filterParam,
  hasChanges,
  sortParam,
  viewColumns,
  viewsKey,
} from './views-state.js';

const PAGE_SIZE = 50;

export function ObjectPage() {
  const { object: name } = useParams({ strict: false }) as { object: string };
  const { session, schema } = useWorkspace();
  const object = schema.objects.find((o) => o.nameSingular === name || o.namePlural === name);
  if (!object)
    return (
      <Page title="Object unavailable">
        <Notice error>This object is no longer in the schema.</Notice>
      </Page>
    );
  // Remount per object so saved column preferences are read once, on mount.
  return <ObjectList key={`${session.workspace.id}:${name}`} name={name} schemaObject={object} />;
}

function ObjectList({ name, schemaObject }: { name: string; schemaObject: ObjectView }) {
  const { session, schema } = useWorkspace();
  const { search, setSearch } = useView();
  const client = useQueryClient();
  const navigate = useNavigate();
  const apiName = useApiName();
  const agentDescription = useAgentDescription();
  // An event type lists its built-in columns and links beside its fields (5.3).
  const object = useMemo(() => eventListObject(schemaObject, schema), [schemaObject, schema]);
  useRememberCommand('object', object.nameSingular);
  const workspace = session.workspace.id;
  const [density, setDensity] = useState(() => loadRowDensity(() => localStorage, workspace, name));
  const [error, setError] = useState(''),
    [createTrigger, setCreateTrigger] = useState<HTMLButtonElement | null>(null),
    [viewDialog, setViewDialog] = useState<'new' | 'edit' | 'delete' | null>(null);
  const writable = canMutate(session);
  // Events are created only by logging them, and cannot be merged.
  const isEvent = object.class === 'event';
  const [localPrefs, setLocalPrefs] = useState(() =>
    loadColumnPrefs(() => localStorage, workspace, name),
  );
  // Column changes to a saved view this key cannot save, kept for the visit.
  const [unsaved, setUnsaved] = useState<Record<string, ColumnPrefs>>({});

  // Saved views (ARCHITECTURE.md 1.4): `?view=` picks one; without it, all records.
  // Keyed by the singular name, as the view dialogs are, whichever name the address uses.
  const objectName = object.nameSingular;
  const views = useQuery({
    queryKey: viewsKey(workspace, objectName),
    queryFn: ({ signal }) => api.views(objectName, signal),
  });
  const draft = useQuery({
    queryKey: [workspace, 'view-open', objectName, search.draft],
    queryFn: ({ signal }) => api.checkView(parseViewDraft(search.draft ?? ''), objectName, signal),
    enabled: !!search.draft,
    retry: false,
  });
  const draftView = draft.data?.ok ? draft.data.preview : undefined;
  const saved = search.view ? views.data?.views.find((v) => v.id === search.view) : undefined;
  const missingView = !!search.view && views.isSuccess && !saved;
  // An event list offers a calendar of when events happened without a saved view.
  const occurred = useMemo(() => occurredCalendar(object), [object]);
  const [settings, setSettings] = useState<{ key: string; patch: UpdateViewInput }>({
    key: '',
    patch: {},
  });
  const settingsKey = search.draft ?? search.view ?? '';
  const overrides = settings.key === settingsKey ? settings.patch : {};
  const base = draftView ?? saved;
  const active = base && applyChange(base, overrides);
  const calendarLayout = isEvent && !active && search.layout === 'calendar';
  const kind = active?.kind ?? (calendarLayout ? 'calendar' : 'table');
  const grouped = kind === 'table' && !!active?.groupBy;
  const selectView = useCallback(
    (id: string | undefined, options: { replace?: boolean } = {}) => {
      rememberView(workspace, objectName, id);
      setSettings({ key: '', patch: {} });
      void setSearch(
        {
          view: id,
          draft: undefined,
          filter: undefined,
          sort: undefined,
          cursor: undefined,
          month: undefined,
          layout: undefined,
        },
        options,
      );
    },
    [workspace, objectName, setSearch],
  );
  const opening = useLastView(
    workspace,
    objectName,
    search,
    // If views fail to load, all records it is.
    views.data?.views ?? (views.isError ? [] : undefined),
    selectView,
  );
  // Until the view is known, nothing loads, so the wrong records never flash.
  const resolving =
    opening || (!!search.view && views.isPending) || (!!search.draft && draft.isPending);
  const brokenDraft = !!search.draft && !resolving && !draftView;

  // The URL's filter and sort are unsaved changes on top of the view.
  const effective = effectiveSearch(active, search);
  const changed = !!draftView || Object.keys(overrides).length > 0 || hasChanges(base, search);
  const view = parseListSearch(effective);
  const { clauses, custom } = view;
  // Events are read newest first unless a sort is chosen; the header shows it.
  const implicitSort = isEvent && !view.query.sort;
  const querySort = implicitSort ? DEFAULT_EVENT_SORT : view.query.sort;
  const sort = view.sort ?? (implicitSort ? DEFAULT_EVENT_SORT[0] : undefined);
  const input: QueryInput = {
    limit: PAGE_SIZE,
    cursor: search.cursor,
    include: ['relationReferences'],
    search: active?.search?.trim() || undefined,
    ...view.query,
    ...(querySort ? { sort: querySort } : {}),
  };
  const query = useQuery({
    queryKey: [workspace, 'records', name, input],
    queryFn: async ({ signal }) => {
      const page = await api.queryRecords(name, input, signal);
      return isEvent ? { ...page, records: page.records.map(withEventValues) } : page;
    },
    enabled: !view.error && !resolving && !brokenDraft && kind === 'table' && !grouped,
  });
  // Built once per copy of the view, so the grid's memos hold across renders.
  const activeColumns = active?.columns;
  const viewPrefs = useMemo(
    () => base && viewColumns({ ...base, columns: activeColumns ?? null }),
    [base, activeColumns],
  );
  const prefs = base ? (unsaved[base.id] ?? viewPrefs) : localPrefs;

  // Cursors only go forward; remember each page's predecessor for "Previous".
  const viewKey = `${settingsKey}|${effective.filter ?? ''}|${effective.sort ?? ''}|${input.search ?? ''}`;
  const [trail, setTrail] = useState<{ key: string; pages: PageTrail }>({
    key: viewKey,
    pages: {},
  });
  const pages = trail.key === viewKey ? trail.pages : {};

  const columns = useMemo(() => resolveColumns(object, prefs), [object, prefs]);
  const count = useQuery({
    queryKey: [workspace, 'aggregate', name, 'count', view.query.filter, input.search],
    queryFn: ({ signal }) =>
      api.aggregate(
        name,
        { filter: view.query.filter, search: input.search, aggregates: [] },
        signal,
      ),
    enabled: !view.error && !resolving && !brokenDraft && kind === 'table' && !grouped,
    placeholderData: (previous) => previous,
  });

  const order = useMemo(
    () => columns.filter((f) => f.name !== object.labelField).map((f) => f.name),
    [columns, object],
  );
  const gridColumns = useMemo(
    () =>
      columns.map((f, i) => ({
        id: f.name,
        label: f.label,
        description: f.description,
        apiName: apiName(f.name),
        width: prefs?.widths[f.name] ?? defaultColumnWidth(f, i === 0),
        sortable: isSortable(f),
        pinned: i === 0,
      })),
    [columns, prefs, apiName],
  );
  const references = query.data?.relationReferences;
  const records = query.data?.records;
  const buildRows = useCallback(
    (rows: RecordPage['records'], references: RecordPage['relationReferences']) =>
      rows.map((r) => {
        const label = recordTitle(r);
        return {
          id: r.id,
          label,
          cells: columns.map((f, i) => {
            const Display = fields[f.type].Display;
            const shown =
              f.name === 'participants' && r.event ? (
                <ParticipantsCell key={f.name} record={r} field={f} references={references} />
              ) : (
                <Display
                  key={f.name}
                  field={f}
                  value={r.fields[f.name]}
                  compact
                  textLines={density === 'expanded' ? 2 : 1}
                  references={references}
                />
              );
            const cellLabel = `${f.label} of ${label}`;
            const copyValue = primaryCopyValue(f.type, r.fields[f.name]);
            if (i === 0) {
              const recordLink = (
                <RecordLink
                  key={f.name}
                  id={r.id}
                  inSheet
                  showOpenIcon
                  avatar={
                    <RecordAvatar
                      id={r.id}
                      name={label}
                      object={r.object}
                      objectClass={object.class}
                    />
                  }
                >
                  {r.label && f.type !== 'links' ? shown : label}
                </RecordLink>
              );
              return copyValue ? (
                <CopyableCell key={f.name} label={cellLabel} value={copyValue} besideAction>
                  {recordLink}
                </CopyableCell>
              ) : (
                recordLink
              );
            }
            if (!writable || !isWritable(f)) {
              return copyValue ? (
                <CopyableCell key={f.name} label={cellLabel} value={copyValue}>
                  {shown}
                </CopyableCell>
              ) : (
                shown
              );
            }
            return (
              <EditableCell
                key={f.name}
                label={cellLabel}
                copyValue={copyValue}
                wide={!pickerFor(f)}
                editor={(close) => (
                  <InlineEditor
                    record={{ ...r, relationReferences: references }}
                    field={f}
                    onDone={close}
                  />
                )}
              >
                {shown}
              </EditableCell>
            );
          }),
        };
      }),
    [columns, writable, object.class, density],
  );

  const rows = useMemo(
    () => buildRows(records ?? [], references),
    [buildRows, records, references],
  );

  // Selection belongs to one page of one view, and only to rows still shown.
  const selectionKey = `${viewKey}|${search.cursor ?? ''}`;
  const [picked, setPicked] = useState<{ key: string; ids: string[] }>({
    key: selectionKey,
    ids: [],
  });
  const shownIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedIds = useMemo(
    () => (picked.key === selectionKey ? shownIds.filter((id) => picked.ids.includes(id)) : []),
    [picked, selectionKey, shownIds],
  );
  const selectRows = useCallback(
    (ids: string[]) => setPicked({ key: selectionKey, ids }),
    [selectionKey],
  );
  const selection = useMemo<GridSelection | undefined>(() => {
    if (!writable) return undefined;
    const selected = new Set(selectedIds);
    return {
      selected,
      onToggle: (id) =>
        selectRows(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]),
      onToggleAll: () => selectRows(selectedIds.length === shownIds.length ? [] : shownIds),
    };
  }, [writable, selectedIds, shownIds, selectRows]);

  const openRow = useCallback((id: string) => void setSearch({ record: id }), [setSearch]);
  // Deleted or erased from a menu or the bar: unselect them, and close the sheet on one.
  const onGone = useCallback(
    (ids: string[]) => {
      selectRows(selectedIds.filter((id) => !ids.includes(id)));
      if (search.record && ids.includes(search.record)) void setSearch({ record: undefined });
    },
    [selectRows, selectedIds, search.record, setSearch],
  );
  // The table's page, or what a grouped table's sections, a board's columns
  // or a calendar's month loaded. Those keep events raw: add their values.
  const byId = useMemo(() => new Map(records?.map((r) => [r.id, r])), [records]);
  const loaded = useLoadedRecord(object.nameSingular);
  const lookup = useCallback(
    (id: string) => {
      const record = byId.get(id) ?? loaded(id);
      return record && isEvent ? withEventValues(record) : record;
    },
    [byId, loaded, isEvent],
  );
  const fieldFor = useCallback(
    (column: string) => columns.find((f) => f.name === column),
    [columns],
  );
  // The right-click menu and the bar for selected rows share one host and
  // read the same actions (spec §2).
  const actions = useActionHost({ onGone, openRecord: openRow });
  const menu = useRecordMenu({
    object,
    lookup,
    // Only an ungrouped table selects rows; only tables have cells (`data-column`).
    selection:
      selection && kind === 'table' && !grouped
        ? { ids: selectedIds, select: selectRows }
        : undefined,
    fieldFor,
    host: actions.host,
  });
  const barTarget = useMemo(
    () => ({
      records: selectedIds.map(lookup).filter((r): r is NonNullable<typeof r> => !!r),
      object,
    }),
    [selectedIds, lookup, object],
  );
  const barActions = useRecordActions(
    selectedIds.length && kind === 'table' ? barTarget : null,
    actions.host,
  );

  const saveView = useSaveView(object);
  async function changeView(change: UpdateViewInput): Promise<boolean> {
    if (!saved) return false;
    try {
      await saveView(saved.id, change);
      return true;
    } catch (e) {
      setError(`The view could not be saved: ${(e as Error).message}`);
      return false;
    }
  }

  function amend(patch: UpdateViewInput) {
    if (patch.groupBy !== undefined && patch.groupBy !== active?.groupBy) {
      patch = { hiddenGroups: null, granularity: null, hideEmptyGroups: null, ...patch };
    }
    if (patch.granularity !== undefined && patch.granularity !== active?.granularity)
      patch = { hiddenGroups: null, ...patch };
    const { sort, ...settingsPatch } = patch;
    if (Object.keys(settingsPatch).length)
      setSettings({ key: settingsKey, patch: { ...overrides, ...settingsPatch } });
    void setSearch({
      cursor: undefined,
      ...(sort !== undefined
        ? { sort: sortParam(sort?.length ? JSON.stringify(sort) : undefined, base) }
        : {}),
    });
  }
  const editWithAgent = useMutation({
    mutationFn: async () => {
      if (!saved) return;
      const current = await api.view(saved.id);
      const context = { view: current.id, ...viewSettings(current) };
      const fence = '```';
      const chat = await newChat(
        [
          `I'd like to change my view "${current.name}" on the ${current.object} object. Use these settings as the starting point and ask me what to change.`,
          ...current.issues.map((issue) => `- ${issue}`),
          `${fence}retainer-view\n${JSON.stringify(context, null, 2)}\n${fence}`,
        ].join('\n\n'),
      );
      await navigate({ to: '/chat/$id', params: { id: chat.id } });
    },
    onError: (error) => setError(error.message),
  });
  function savePrefs(next: ColumnPrefs) {
    if (draftView) return amend({ columns: next });
    if (saved) {
      // A view's columns are part of the view; a key that can't save keeps them for the visit.
      if (!writable) return setUnsaved((u) => ({ ...u, [saved.id]: next }));
      void changeView({ columns: next });
      return;
    }
    setLocalPrefs(next);
    if (!saveColumnPrefs(() => localStorage, workspace, name, next))
      setError('Column preferences could not be saved in this browser');
  }
  /** Changes some preferences and keeps the rest. */
  const patchPrefs = (patch: Partial<ColumnPrefs>) =>
    savePrefs({ order, widths: {}, ...prefs, ...patch });
  const saveOrder = (next: string[]) => patchPrefs({ order: next });
  const setFilter = (next: FilterParts | undefined) =>
    void setSearch({ filter: filterParam(next && encodeFilter(next), base), cursor: undefined });
  const removeCustom = (index: number) =>
    setFilter({ clauses, custom: custom.filter((_, i) => i !== index) });
  const setSort = (next: string | undefined) =>
    void setSearch({ sort: sortParam(next, base), cursor: undefined });
  const resetChanges = () => {
    setSettings({ key: '', patch: {} });
    if (draftView) return selectView(draftView.id || undefined);
    void setSearch({ filter: undefined, sort: undefined, cursor: undefined });
  };
  const keep = useMutation({
    mutationFn: async () => {
      if (!draftView || !active) return;
      const { filter, sort } = changesToSave(active, search);
      const next = { ...viewSettings(active), filter, sort };
      if (draftView.id)
        return api.updateView(draftView.id, { ...next, expectedUpdatedAt: draftView.updatedAt });
      return api.createView(objectName, { ...next, visibility: 'private' });
    },
    onSuccess: async (kept) => {
      if (!kept) return;
      await client.invalidateQueries({ queryKey: viewsKey(workspace, objectName) });
      selectView(kept.id);
    },
    onError: async (error) => {
      setError(error.message);
      if ('status' in error && error.status === 409) await draft.refetch();
    },
  });
  async function saveChanges() {
    if (draftView) return keep.mutate();
    const patch =
      overrides.search === undefined
        ? overrides
        : { ...overrides, search: overrides.search?.trim() || null };
    if (saved && active && (await changeView({ ...patch, ...changesToSave(active, search) })))
      resetChanges();
  }
  const layoutChange = (change: UpdateViewInput) =>
    draftView ? amend(change) : void changeView(change);
  const grid = {
    label: object.labelPlural,
    expanded: density === 'expanded',
    columns: gridColumns,
    sort: sort ? { column: sort.field, direction: sort.direction } : undefined,
    onSort: (column: string) => setSort(nextSort(view.sort, column)),
    onResize: (column: string, width: number) =>
      patchPrefs({ widths: { ...prefs?.widths, [column]: width } }),
    onReorder: (column: string, target: string) => saveOrder(moveColumn(order, column, target)),
    onOpenRow: openRow,
    selectedRow: search.record,
  };
  const nextCursor = query.data?.nextCursor;
  const previous = search.cursor ? pages[search.cursor] : undefined;

  return (
    <Page
      layout="fill"
      eyebrow={isEvent ? 'Activity' : 'Records'}
      eyebrowLink={isEvent ? { to: '/activity' } : undefined}
      title={object.labelPlural}
      icon={<ObjectIcon name={object.nameSingular} objectClass={object.class} />}
      apiName={apiName(object.nameSingular)}
      actions={
        !isEvent ? (
          writable ? (
            <Button
              variant="primary"
              size="small"
              className="max-w-[50vw]"
              onClick={(event) => setCreateTrigger(event.currentTarget)}
            >
              <Plus size={14} />
              <span className="truncate">New {object.labelSingular.toLowerCase()}</span>
            </Button>
          ) : null
        ) : (
          // Events have no New button; say why in its place (5.3).
          <LoggedByAgents />
        )
      }
    >
      {/* Agent view: what agents read about this object, under the list title. */}
      <DescriptionLine className="shrink-0 border-b border-border px-3 py-2 md:px-5">
        {agentDescription(schemaObject.description)}
      </DescriptionLine>
      {selectedIds.length && kind === 'table' ? (
        <Toolbar
          end={
            <Button variant="ghost" size="small" onClick={() => selectRows([])}>
              Clear selection
            </Button>
          }
        >
          <Muted>{selectedIds.length} selected</Muted>
          <SelectionActions actions={barActions} isEvent={isEvent} count={selectedIds.length} />
        </Toolbar>
      ) : (
        <Toolbar
          end={
            <>
              {changed ? (
                <>
                  <Button variant="ghost" size="small" onClick={resetChanges}>
                    Reset
                  </Button>
                  {writable && !view.error ? (
                    <Button
                      size="small"
                      disabled={keep.isPending}
                      onClick={() => void saveChanges()}
                    >
                      <Save size={14} />
                      Save view
                    </Button>
                  ) : null}
                </>
              ) : !saved && writable && (effective.filter || effective.sort) ? (
                <Button variant="ghost" size="small" onClick={() => setViewDialog('new')}>
                  <BookmarkPlus size={14} />
                  Save as view…
                </Button>
              ) : null}
              {active && active.kind !== 'table' && writable ? (
                <ViewOptions object={object} view={active} onChange={layoutChange} />
              ) : null}
              {isEvent && !active ? (
                <Segmented
                  label="Layout"
                  value={calendarLayout ? 'calendar' : 'table'}
                  options={[
                    { value: 'table', label: 'Table', icon: <Table2 size={12} /> },
                    { value: 'calendar', label: 'Calendar', icon: <CalendarDays size={12} /> },
                  ]}
                  onChange={(next) =>
                    void setSearch({
                      layout: next === 'calendar' ? 'calendar' : undefined,
                      cursor: undefined,
                      month: undefined,
                    })
                  }
                />
              ) : null}
              {kind === 'table' ? (
                <Segmented
                  label="Row height"
                  value={density}
                  options={[
                    { value: 'compact', label: 'Compact' },
                    { value: 'expanded', label: 'Expanded' },
                  ]}
                  onChange={(next) => {
                    setDensity(next);
                    saveRowDensity(() => localStorage, workspace, name, next);
                  }}
                />
              ) : null}
              {kind !== 'calendar' ? (
                <ColumnsMenu
                  title={kind === 'board' ? 'Card fields' : 'Columns'}
                  object={object}
                  columns={columns}
                  order={order}
                  onChange={saveOrder}
                  onReset={() => savePrefs({ order: defaultColumnOrder(object), widths: {} })}
                />
              ) : null}
              <SortMenu
                object={object}
                sort={sort}
                onChange={(next) => setSort(encodeSort(next))}
              />
            </>
          }
        >
          <ViewSwitcher
            object={object}
            views={views.data?.views ?? []}
            current={active}
            writable={writable}
            onSelect={(id) => selectView(id)}
            onNew={() => setViewDialog('new')}
            newWithAgent={canStart('view', session)}
            onEdit={() => setViewDialog('edit')}
            onEditAgent={saved ? () => editWithAgent.mutate() : undefined}
            onDelete={() => setViewDialog('delete')}
          />
          {clauses.map((c, i) => (
            <FilterChip
              key={`${c.field}:${c.operator}:${JSON.stringify(c.value)}`}
              {...describeClause(
                c,
                object.fields.find((f) => f.name === c.field),
                references,
                schema.objects,
              )}
              onRemove={() => setFilter({ clauses: clauses.filter((_, j) => j !== i), custom })}
            />
          ))}
          {active && (active.search != null || base?.search) && (
            <Input
              aria-label="Search this view"
              placeholder="Search this view"
              value={active.search ?? ''}
              maxLength={200}
              onChange={(event) => amend({ search: event.target.value || null })}
            />
          )}
          <FilterMenu
            object={object}
            custom={custom.length > 0}
            onEditAgent={saved ? () => editWithAgent.mutate() : undefined}
            onApply={(clause) => {
              setError('');
              setFilter({ clauses: addClause(clauses, clause), custom });
            }}
            onError={setError}
          />
          {clauses.length + custom.length > 1 ? (
            <Button variant="ghost" size="small" onClick={() => setFilter(undefined)}>
              Clear filters
            </Button>
          ) : null}
        </Toolbar>
      )}
      {(active || custom.length > 0) && (
        <div className="px-4 py-1.5">
          {active ? (
            <SettingsSummary
              view={{ ...active, sort: view.query.sort ?? null }}
              object={object}
              change={amend}
              filters={custom.map((part, index) => ({
                text: describeFilter(part, object),
                remove: () => removeCustom(index),
              }))}
            />
          ) : (
            custom.map((part, index) => (
              <FilterChip
                key={JSON.stringify(part)}
                field={describeFilter(part, object)}
                value=""
                onRemove={() => removeCustom(index)}
              />
            ))
          )}
        </div>
      )}
      {error || view.error || query.error || missingView || active?.issues.length || brokenDraft ? (
        <Inset>
          {error || view.error ? (
            <Notice error onDismiss={error ? () => setError('') : undefined}>
              {error || view.error}
            </Notice>
          ) : null}
          {missingView ? (
            <Notice onDismiss={() => selectView(undefined, { replace: true })}>
              This view was deleted, or only the person who made it can see it. Showing all{' '}
              {object.labelPlural.toLowerCase()}.
            </Notice>
          ) : null}
          {active?.issues.length ? <Notice>{active.issues.join(' ')}</Notice> : null}
          {brokenDraft && (
            <Notice error>
              {draft.error?.message ??
                (draft.data && !draft.data.ok
                  ? draft.data.problems.map((problem) => problem.message).join(' ')
                  : 'This draft is unavailable.')}
            </Notice>
          )}
          {query.error ? (
            <QueryError error={query.error} retry={() => void query.refetch()} />
          ) : null}
        </Inset>
      ) : null}
      <div className="contents" {...menu.handlers}>
        {resolving ? (
          <Inset>
            <Notice>Loading view…</Notice>
          </Inset>
        ) : brokenDraft ? null : active?.kind === 'board' && !view.error ? (
          <BoardView
            object={object}
            view={active}
            search={input.search}
            filter={view.query.filter}
            sort={view.query.sort}
            order={prefs?.order}
            writable={writable}
            selected={search.record}
            onOpen={openRow}
            onChangeView={layoutChange}
          />
        ) : (active?.kind === 'calendar' || calendarLayout) && !view.error ? (
          <CalendarView
            object={object}
            view={active ?? occurred}
            search={input.search}
            filter={view.query.filter}
            sort={view.query.sort}
            month={search.month}
            writable={writable}
            selected={search.record}
            onOpen={openRow}
            onMonth={(month) => void setSearch({ month })}
            onChangeView={layoutChange}
          />
        ) : kind !== 'table' ? null : grouped && active && !view.error ? (
          <GroupedTable
            key={JSON.stringify([active.id, active.groupBy, active.granularity])}
            object={object}
            view={active}
            input={input}
            render={(pages) => (
              <DataGrid
                {...grid}
                rows={pages.flatMap((page) =>
                  buildRows(
                    isEvent ? page.records.map(withEventValues) : page.records,
                    page.relationReferences,
                  ),
                )}
              />
            )}
          />
        ) : query.isPending && !view.error && !grouped ? (
          <Inset>
            <Notice>Loading records…</Notice>
          </Inset>
        ) : rows.length ? (
          <DataGrid {...grid} rows={rows} selection={selection} />
        ) : query.data ? (
          <Inset>
            <Empty
              quiet
              title="No records found"
              description={
                effective.filter
                  ? 'No records match these filters.'
                  : isEvent
                    ? `Ask your agent to log ${object.labelPlural.toLowerCase()}, and they will show up here.`
                    : `Ask your agent to add records${canMutate(session) ? ', or create one with the New button' : ', and they will show up here'}.`
              }
            />
          </Inset>
        ) : null}
      </div>
      {query.data && kind === 'table' ? (
        <GridFooter
          end={
            <>
              <Button
                variant="ghost"
                size="small"
                disabled={!search.cursor}
                onClick={() => void setSearch({ cursor: previous?.previous })}
              >
                <ChevronLeft size={14} />
                {search.cursor && !previous ? 'First page' : 'Previous'}
              </Button>
              <Button
                variant="ghost"
                size="small"
                disabled={!nextCursor}
                onClick={() => {
                  if (!nextCursor) return;
                  setTrail({
                    key: viewKey,
                    pages: recordNextPage(pages, search.cursor, nextCursor),
                  });
                  void setSearch({ cursor: nextCursor });
                }}
              >
                Next
                <ChevronRight size={14} />
              </Button>
            </>
          }
        >
          {pageRange(pages, search.cursor, rows.length, PAGE_SIZE, count.data?.total)}
          {nextCursor && !count.data ? ' · more available' : ''}
        </GridFooter>
      ) : null}
      {createTrigger && !isEvent ? (
        <CreateRecordDialog
          object={object}
          returnFocus={createTrigger}
          onClose={() => setCreateTrigger(null)}
          onCreated={(id) => {
            setCreateTrigger(null);
            void setSearch({ record: id });
          }}
        />
      ) : null}
      {actions.element}
      {viewDialog === 'new' || (viewDialog === 'edit' && saved) ? (
        <ViewDialog
          object={object}
          view={viewDialog === 'edit' ? saved : undefined}
          base={{
            filter: view.query.filter,
            sort: view.query.sort,
            // As the grid shows them: stored ones can name fields that are gone.
            columns: shownColumnPrefs(object, prefs),
          }}
          onClose={() => setViewDialog(null)}
          onSaved={(next) => {
            setViewDialog(null);
            if (next.id !== saved?.id) selectView(next.id);
          }}
        />
      ) : null}
      {viewDialog === 'delete' && saved ? (
        <DeleteViewDialog
          object={object}
          view={saved}
          onClose={() => setViewDialog(null)}
          onDeleted={() => {
            setViewDialog(null);
            selectView(undefined, { replace: true });
          }}
        />
      ) : null}
      {menu.element}
      {search.record ? (
        <RecordSheet id={search.record} onClose={() => void setSearch({ record: undefined })} />
      ) : null}
    </Page>
  );
}

/**
 * The bar's actions for the selected rows: a "Run routine" menu when there
 * are routine buttons, then Change and Danger as buttons.
 */
function SelectionActions({
  actions,
  isEvent,
  count,
}: {
  actions: RecordAction[];
  isEvent: boolean;
  count: number;
}) {
  const run = actions.filter((a) => a.group === 'run');
  const rest = actions.filter((a) => a.group === 'change' || a.group === 'danger');
  return (
    <>
      {run.length ? (
        <Menu
          label="Run"
          trigger={
            <Button size="small">
              <Play size={14} />
              Run
              <ChevronDown size={14} />
            </Button>
          }
        >
          <RecordActionItems actions={run} />
        </Menu>
      ) : null}
      {rest.map((a) => (
        <Button
          key={a.id}
          size="small"
          variant={a.destructive ? 'destructive' : undefined}
          onClick={a.run}
        >
          <a.icon size={14} />
          {a.label}
        </Button>
      ))}
      {count === 2 && isEvent ? <Muted small>Events can’t be merged</Muted> : null}
    </>
  );
}
