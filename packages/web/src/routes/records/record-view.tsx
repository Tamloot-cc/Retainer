import { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, FieldView, ObjectView, PresentedRecord } from '@retainer/shared';
import {
  isCollectionRelation,
  isInverseRelation,
  isPolymorphic,
  validateFieldValue,
} from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, History, Maximize2, Pencil } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { FieldPicker, pickerFor } from '../../fields/common.js';
import { primaryCopyValue } from '../../fields/copy-value.js';
import { fields } from '../../fields/index.js';
import { AssertionSource, SourcedValue } from '../../provenance/index.js';
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  Markdown,
  Muted,
  Notice,
  ObjectLink,
  Panel,
  PanelBody,
  Property,
  PropertyEditor,
  PropertyList,
  RecordAvatar,
  RecordLink,
  Row,
  Section,
  Sheet,
  Stack,
} from '../../ui/index.js';
import { useRememberCommand } from '../command-recents.js';
import { DeveloperFacts, useAgentDescription, useApiName } from '../developer.js';
import { EventDetailsView } from '../events/event-details.js';
import { ExtensionRecordButtons } from '../extensions/record-buttons.js';
import { RoutineButtons } from '../routines/record-buttons.js';
import { classLabel, objectByName, QueryError, recordTitle, relationsTo } from '../state.js';
import { RecordActions } from './actions.js';
import { type MemoryNav, type MemoryState, MemoryTabs, pointsAt } from './record-memory.js';
import { isWritable } from './write-model.js';

function AssertionCard({ assertion }: { assertion: AssertionView }) {
  const { schema } = useWorkspace();
  const field = objectByName(schema, assertion.object)?.fields.find(
    (f) => f.name === assertion.field,
  );
  const Display = field ? fields[field.type].Display : null;
  return (
    <Panel>
      <Stack>
        <Row>
          <Badge>{assertion.status}</Badge>
          <RecordLink id={assertion.recordId}>
            {recordTitle({ label: assertion.recordLabel })}
          </RecordLink>
          <Muted>{field?.label ?? assertion.field}</Muted>
        </Row>
        {field && Display ? (
          <Display
            field={field}
            value={assertion.value}
            references={assertion.relationReferences}
          />
        ) : (
          <Muted>Field unavailable</Muted>
        )}
        <AssertionSource assertion={assertion} />
      </Stack>
    </Panel>
  );
}

export function useRecord(id: string) {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [session.workspace.id, 'record', id],
    queryFn: ({ signal }) => api.record(id, ['provenance', 'relationReferences', 'counts'], signal),
  });
}

/**
 * Polymorphic relations that may point at records of `object`, with the
 * object each belongs to. They have no field on this side, so a record finds
 * what links to it by filtering on them.
 */
export function polymorphicLinksTo(objects: ObjectView[], object: string) {
  return objects.flatMap((o) =>
    relationsTo(o.fields, object)
      .filter((f) => isPolymorphic(f) && f.isFilterable)
      .map((field) => ({ object: o, field })),
  );
}

/** A record opened from a list, in a sheet over it. */
export function RecordSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { schema } = useWorkspace();
  const record = useRecord(id);
  // The tab belongs to one record; opening another row starts it fresh.
  const [memory, setMemory] = useState<{ id: string } & MemoryState>({ id });
  const nav = memory.id === id ? memory : { id };
  const [extensionReport, setExtensionReport] = useState<{ id: string; message: string }>();
  const reportExtension = useCallback(
    (message: string) => setExtensionReport({ id, message }),
    [id],
  );
  const r = record.data;
  const object = r ? objectByName(schema, r.object) : undefined;
  return (
    <Sheet
      onClose={onClose}
      getReturnFocus={(opener) => {
        const selector = `[data-record-sheet-trigger~="${CSS.escape(id)}"]`;
        return opener instanceof HTMLElement && opener.isConnected && opener.matches(selector)
          ? opener
          : document.querySelector<HTMLElement>(selector);
      }}
      eyebrow={classLabel(object)}
      title={r ? recordTitle(r) : 'Record'}
      avatar={
        r ? (
          <RecordAvatar
            id={r.id}
            name={recordTitle(r)}
            object={r.object}
            objectClass={object?.class}
            large
          />
        ) : undefined
      }
      subtitle={r ? `Updated ${new Date(r.updatedAt).toLocaleString()}` : undefined}
      description="Record details. Click a value to edit it."
      actions={
        <>
          {r ? (
            <ExtensionRecordButtons object={r.object} recordId={r.id} onReport={reportExtension} />
          ) : null}
          {r ? <RoutineButtons object={r.object} recordId={r.id} /> : null}
          {r ? <RecordActions record={r} requestedId={id} onGone={onClose} /> : null}
          <Button asChild variant="ghost" size="icon">
            <Link
              to="/r/$id"
              params={{ id: r?.id ?? id }}
              aria-label="Open full page"
              title="Open full page"
            >
              <Maximize2 size={15} />
            </Link>
          </Button>
        </>
      }
    >
      {extensionReport?.id === id ? (
        <Notice onDismiss={() => setExtensionReport(undefined)}>{extensionReport.message}</Notice>
      ) : null}
      {r ? (
        <RecordView
          key={r.id}
          record={r}
          requestedId={id}
          nav={{ ...nav, set: (change) => setMemory({ ...nav, ...change }) }}
        />
      ) : record.error ? (
        <QueryError error={record.error} retry={() => void record.refetch()} />
      ) : (
        <Notice>Loading record…</Notice>
      )}
    </Sheet>
  );
}

/** A record's fields, relations and memory, shared by the record page and the sheet. */
export function RecordView({
  record: r,
  requestedId,
  nav,
}: {
  record: PresentedRecord;
  requestedId: string;
  nav: MemoryNav;
}) {
  const { session, schema } = useWorkspace(),
    apiName = useApiName(),
    agentDescription = useAgentDescription();
  useRememberCommand('record', r.id);
  const [history, setHistory] = useState<FieldView | null>(null);
  const rid = r.id;
  const object = objectByName(schema, r.object),
    canWrite = canMutate(session) && !r.event?.source;
  const own = object?.fields.filter((f) => !isInverseRelation(f)) ?? [];
  const inverse = object?.fields.filter(isInverseRelation) ?? [];
  const incoming = polymorphicLinksTo(schema.objects, r.object);
  return (
    <>
      {r.id !== requestedId ? (
        <Notice>This record was merged. You’re viewing the surviving record.</Notice>
      ) : null}
      <DeveloperFacts record={r} object={object} />
      {r.event ? (
        <Section title="Event">
          <EventDetailsView id={r.id} event={r.event} editable={canWrite} />
        </Section>
      ) : null}
      <Section title="Fields">
        <PropertyList>
          {own.map((f) => (
            <FieldProperty
              key={f.name}
              record={r}
              field={f}
              apiName={apiName(f.name)}
              editable={canWrite && isWritable(f)}
              onHistory={() => setHistory(f)}
            />
          ))}
        </PropertyList>
      </Section>
      {inverse.length || incoming.length ? (
        <Section title="Relations">
          <PropertyList>
            {inverse.map((f) => {
              const Display = fields[f.type].Display;
              return (
                <Property
                  key={f.name}
                  label={f.label}
                  apiName={apiName(f.name)}
                  descriptionLine={agentDescription(f.description)}
                >
                  <Stack>
                    <Display
                      field={f}
                      value={
                        Array.isArray(r.fields[f.name])
                          ? (r.fields[f.name] as string[]).slice(0, 5)
                          : []
                      }
                      references={r.relationReferences}
                    />
                    {f.settings.targetObject && f.settings.inverseField ? (
                      <ObjectLink
                        object={f.settings.targetObject}
                        filter={JSON.stringify({
                          // The other side holds this record: as its value, or in its set.
                          [f.settings.inverseField]: pointsAt(f, rid),
                        })}
                      >
                        View related records
                      </ObjectLink>
                    ) : null}
                  </Stack>
                </Property>
              );
            })}
            {incoming.map(({ object: o, field: f }) => (
              <Property
                key={`${o.nameSingular}.${f.name}`}
                label={`${o.labelSingular} → ${f.label}`}
              >
                <ObjectLink
                  object={o.nameSingular}
                  filter={JSON.stringify({ [f.name]: pointsAt(f, rid) })}
                >
                  View {o.labelPlural.toLowerCase()} linking here
                </ObjectLink>
              </Property>
            ))}
          </PropertyList>
        </Section>
      ) : null}
      <MemoryTabs record={r} nav={nav} />
      {history ? (
        <FieldHistoryDialog recordId={rid} field={history} onClose={() => setHistory(null)} />
      ) : null}
    </>
  );
}

/**
 * Every claim on one field of a record: who made it, from which source, and
 * which one won. From the sheet's History button and a cell's right-click menu.
 */
export function FieldHistoryDialog({
  recordId,
  field,
  onClose,
}: {
  recordId: string;
  field: Pick<FieldView, 'name' | 'label'>;
  onClose: () => void;
}) {
  const { session } = useWorkspace();
  const [cursor, setCursor] = useState<string>();
  const hist = useQuery({
    queryKey: [session.workspace.id, 'assertions', recordId, field.name, cursor],
    queryFn: ({ signal }) => api.assertions(recordId, { field: field.name, cursor, signal }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`History of ${field.label}`}
    >
      <Stack>
        {hist.error ? <QueryError error={hist.error} /> : null}
        {hist.isPending ? <Notice>Loading history…</Notice> : null}
        {hist.data?.items.map((a) => (
          <AssertionCard key={a.id} assertion={a} />
        ))}
        {hist.data && !hist.data.items.length ? <Muted>No assertions for this field.</Muted> : null}
        <Row>
          {cursor ? <Button onClick={() => setCursor(undefined)}>First page</Button> : null}
          {hist.data?.nextCursor ? (
            <Button onClick={() => setCursor(hist.data?.nextCursor ?? undefined)}>
              Next page of history
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Dialog>
  );
}

/** One field: its value with provenance, edited in place when clicked. */
export function FieldProperty({
  record,
  field,
  apiName,
  editable,
  onHistory,
}: {
  record: PresentedRecord;
  field: FieldView;
  apiName?: string;
  editable: boolean;
  onHistory: () => void;
}) {
  const { session } = useWorkspace();
  const descriptionLine = useAgentDescription()(field.description);
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const Display = fields[field.type].Display;
  const copyValue = primaryCopyValue(field.type, record.fields[field.name]);
  function done(outside = false) {
    // Commit the close first, so the Edit button exists to take focus back;
    // after a click elsewhere, focus stays where the click put it.
    flushSync(() => setEditing(false));
    if (!outside) editButton.current?.focus();
  }
  return (
    <Property
      label={field.label}
      description={field.description}
      apiName={apiName}
      descriptionLine={descriptionLine}
      onEdit={editable ? () => setEditing(true) : undefined}
      editor={editing ? <InlineEditor record={record} field={field} onDone={done} /> : null}
      actions={
        <>
          {copyValue ? (
            <CopyButton label={`Copy ${field.label}`} value={copyValue} iconOnly />
          ) : null}
          {field.type === 'text' && record.fields[field.name] ? (
            <Button
              variant="ghost"
              size="iconSmall"
              aria-label={`${markdown ? 'Show plain text' : 'Render Markdown'} for ${field.label}`}
              title={markdown ? 'Show plain text' : 'Render Markdown'}
              aria-pressed={markdown}
              onClick={() => setMarkdown(!markdown)}
            >
              <FileText size={13} />
            </Button>
          ) : null}
          {editable ? (
            <Button
              ref={editButton}
              variant="ghost"
              size="iconSmall"
              aria-label={`Edit ${field.label}`}
              title="Edit"
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="iconSmall"
            aria-label={`History of ${field.label}`}
            title="History"
            onClick={onHistory}
          >
            <History size={13} />
          </Button>
        </>
      }
    >
      <SourcedValue
        field={field}
        provenance={record.provenance?.[field.name]}
        viewer={session.actor}
      >
        {markdown &&
        typeof record.fields[field.name] === 'string' &&
        record.fields[field.name] !== '' ? (
          <Markdown>{record.fields[field.name] as string}</Markdown>
        ) : (
          <Display
            field={field}
            value={record.fields[field.name]}
            references={record.relationReferences}
          />
        )}
      </SourcedValue>
    </Property>
  );
}

/**
 * Whether a draft holds the value already stored. A set compares as members
 * in ID order, as the server keeps it; the order they were picked in is not
 * a change.
 */
export function sameValue(field: FieldView, draft: unknown, current: unknown) {
  const shape = (v: unknown) =>
    isCollectionRelation(field) && Array.isArray(v) ? [...new Set(v)].sort() : (v ?? null);
  return JSON.stringify(shape(draft)) === JSON.stringify(shape(current));
}

/**
 * Saves one field with the record's `updatedAt` as the precondition. A stale
 * write keeps the draft open beside the latest value; retrying is explicit.
 *
 * Fields chosen from a list open on the list: one choice saves on the pick,
 * several when the list is left (a click outside, Enter with nothing
 * highlighted, or ⌘/Ctrl+Enter). Other fields open a small form. Either way a
 * click outside saves a changed draft, and Escape drops it. `onDone` is told
 * whether a click outside closed the editor, so focus can stay where it went.
 */
export function InlineEditor({
  record,
  field,
  onDone,
}: {
  record: PresentedRecord;
  field: FieldView;
  onDone: (outside?: boolean) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient();
  const current = record.fields[field.name] ?? null;
  const [draft, setDraft] = useState<unknown>(current),
    [error, setError] = useState(''),
    [saving, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [stale, setStale] = useState(false);
  const busy = saving || uploading;
  const { Input, Display } = fields[field.type];
  const picker = pickerFor(field);
  // Wait only for the record (the next save's precondition); the rest of the
  // workspace, including the list behind a sheet, refreshes in the background.
  async function refresh() {
    void client.invalidateQueries({
      queryKey: [session.workspace.id],
      predicate: (q) => q.queryKey[1] !== 'record',
    });
    await client.invalidateQueries({ queryKey: [session.workspace.id, 'record'] });
  }
  async function save(next: unknown = draft, outside = false) {
    if (busy) return;
    // Nothing to write: leave without adding to the field's history.
    if (sameValue(field, next, current)) return onDone(outside);
    setBusy(true);
    try {
      const value = validateFieldValue(field, next);
      const result = await api.patchRecord(record.id, {
        values: { [field.name]: value },
        expectedUpdatedAt: record.updatedAt,
      });
      await refresh();
      if (result.fields[field.name] !== 'applied') {
        setError('Saved to history; the current value was not replaced.');
      } else onDone(outside);
    } catch (e) {
      if (e instanceof RetainerApiError && e.status === 412) {
        setStale(true);
        setError(
          'This record changed. Your draft is preserved below. Compare it with the current value before retrying.',
        );
        await refresh();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const problems =
    error || stale ? (
      <>
        {error ? <Notice error>{error}</Notice> : null}
        {stale ? (
          <Panel title="Current value">
            <Display field={field} value={current} references={record.relationReferences} />
          </Panel>
        ) : null}
      </>
    ) : null;
  const saveLabel = busy ? 'Saving…' : stale ? 'Retry with latest version' : 'Save';
  return (
    <PropertyEditor
      kind={picker ? 'picker' : 'form'}
      busy={busy}
      onSave={() => void save()}
      onCancel={() => {
        if (!busy) onDone();
      }}
      onOutside={() => {
        if (busy) return;
        // While the editor shows a problem (a stale write, a write kept only
        // in history, a rejected value), clicking away leaves it: only an
        // explicit Save or Retry writes again.
        if (error || stale) onDone(true);
        else void save(draft, true);
      }}
      footerStart={
        !picker && field.isNullable ? (
          <Button size="small" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Clear
          </Button>
        ) : null
      }
      footer={
        // A list saves by being picked from; it shows a button only to retry.
        picker && !stale ? null : (
          <>
            {picker ? null : (
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                title="Esc"
                onClick={() => onDone()}
              >
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" size="small" disabled={busy} title="Enter">
              {saveLabel}
            </Button>
          </>
        )
      }
    >
      {picker ? (
        <>
          {problems ? <PanelBody>{problems}</PanelBody> : null}
          <FieldPicker
            field={field}
            value={draft}
            references={record.relationReferences}
            onChange={(next) => {
              // One save at a time: a pick while one is in flight would show
              // as chosen but never be written.
              if (busy) return;
              setDraft(next);
              if (picker === 'one') void save(next);
            }}
          />
        </>
      ) : (
        <>
          {problems}
          <Input
            onBusyChange={setUploading}
            field={field}
            value={draft}
            references={record.relationReferences}
            onChange={setDraft}
          />
        </>
      )}
    </PropertyEditor>
  );
}
