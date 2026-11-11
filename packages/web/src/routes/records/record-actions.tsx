import { RetainerApiError } from '@retainer/sdk';
import type { ForgetResult, PresentedRecord, RecordReference } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, MoreHorizontal, ShieldX, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Button,
  Dialog,
  EventLink,
  Form,
  FormField,
  Input,
  Menu,
  MenuAction,
  MenuSeparator,
  Muted,
  Notice,
  RecordLink,
  Row,
  Stack,
} from '../../ui/index.js';
import {
  eventTitle,
  objectByName,
  QueryError,
  recordTitle as title,
  useRecordLabel,
  useReport,
} from '../state.js';
import { MergePicker } from './merge.js';
import { describeImpact, forgetConfirmation } from './write-model.js';

/**
 * The record's actions menu, in the sheet and on the record page: merge a
 * duplicate in (not for events, which cannot be merged), delete, and erase
 * for privacy (admin). `onGone` leaves the
 * screen after the record is deleted or erased; `requestedId` is the ID the
 * screen was opened with, which differs from the record's after a merge.
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
  const [action, setAction] = useState<'merge' | 'delete' | 'forget' | null>(null);
  const isEvent = !!record.event || objectByName(schema, record.object)?.class === 'event';
  const canWrite = canMutate(session),
    canErase = canMutate(session, 'admin');
  if (!canWrite) return null;
  const close = () => setAction(null);
  // Leave first, then drop the record's queries (under both IDs) so nothing
  // refetches a record that no longer exists, and refresh the rest.
  const leave = () => {
    const wid = session.workspace.id;
    onGone();
    for (const id of new Set([record.id, requestedId]))
      client.removeQueries({ queryKey: [wid, 'record', id] });
    void client.invalidateQueries({ queryKey: [wid] });
  };
  return (
    <>
      <Menu
        label="Record actions"
        align="end"
        trigger={
          <Button variant="ghost" size="icon" aria-label="Record actions" title="Record actions">
            <MoreHorizontal size={16} />
          </Button>
        }
      >
        {isEvent ? null : (
          <>
            <MenuAction onSelect={() => setAction('merge')}>
              <Combine size={14} />
              Merge a duplicate…
            </MenuAction>
            <MenuSeparator />
          </>
        )}
        <MenuAction destructive onSelect={() => setAction('delete')}>
          <Trash2 size={14} />
          Delete…
        </MenuAction>
        {canErase ? (
          <MenuAction destructive onSelect={() => setAction('forget')}>
            <ShieldX size={14} />
            Erase for privacy…
          </MenuAction>
        ) : null}
      </Menu>
      {action === 'merge' && !isEvent ? <MergePicker record={record} onClose={close} /> : null}
      {action === 'delete' ? (
        <DeleteDialog record={record} isEvent={isEvent} onClose={close} onGone={leave} />
      ) : null}
      {action === 'forget' ? <ForgetDialog record={record} onClose={close} onGone={leave} /> : null}
    </>
  );
}

type ActionProps = {
  record: PresentedRecord;
  onClose: () => void;
  /** Leaves the screen of a record that no longer exists. */
  onGone: () => void;
};

function DeleteDialog({ record, isEvent, onClose, onGone }: ActionProps & { isEvent: boolean }) {
  const { session, schema } = useWorkspace(),
    report = useReport();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Counted by the server over every cascading link, at any depth.
  const impact = useQuery({
    queryKey: [session.workspace.id, 'deleteImpact', record.id],
    queryFn: ({ signal }) => api.deleteImpact(record.id, signal),
  });
  const linked = impact.data?.records ?? [];
  async function remove() {
    setBusy(true);
    setError('');
    try {
      if (isEvent) {
        // Deleting an event also retracts the claims that cite it (6.4).
        const result = await api.deleteEvent(record.id);
        report(
          `Deleted ${title(record)}: ${plural(result.retractedAssertions, 'value', 'values')} retracted, ${plural(result.recomputedRecordIds.length, 'record', 'records')} recomputed, ${plural(result.hiddenFactIds.length, 'fact', 'facts')} hidden.`,
        );
        onGone();
        return;
      }
      const result = await api.deleteRecord(record.id);
      const others = result.deletedRecordIds.filter((id) => id !== record.id).length;
      report(
        others
          ? `Deleted ${title(record)} and ${others} linked ${others === 1 ? 'record' : 'records'}.`
          : `Deleted ${title(record)}.`,
      );
      onGone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Delete ${title(record)}?`}
      description={
        isEvent
          ? 'The values it recorded are retracted and affected records recomputed. Facts with no other live sources are hidden. It can’t be restored from the app.'
          : 'It disappears from lists, search and the records that link to it. Its history stays stored, but it can’t be restored from the app.'
      }
    >
      <Stack>
        {error ? <Notice error>{error}</Notice> : null}
        {impact.error ? (
          <QueryError error={impact.error} retry={() => void impact.refetch()} />
        ) : null}
        {impact.isPending ? <Notice>Checking linked records…</Notice> : null}
        {linked.length ? (
          <Notice error>
            Deleting it also deletes {describeImpact(linked, schema.objects)} linked to it.
          </Notice>
        ) : null}
        <Row>
          <Button
            variant="destructive"
            disabled={busy || !impact.data}
            onClick={() => void remove()}
          >
            {busy ? 'Deleting…' : 'Delete record'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

/**
 * Deletes several records picked in a list, one at a time. The warning counts
 * what cascades from all of them together, so a linked record two of them
 * share counts once. `onDone` gets the records that could not be deleted, so
 * the list can keep them selected.
 */
export function BulkDeleteDialog({
  ids,
  noun,
  onClose,
  onDone,
}: {
  ids: string[];
  /** What the records are called, singular and plural: ['company', 'companies']. */
  noun: [string, string];
  onClose: () => void;
  onDone: (failed: string[], deleted: string[]) => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    report = useReport();
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0);
  const impact = useQuery({
    queryKey: [session.workspace.id, 'deleteImpact', ...[...ids].sort()],
    queryFn: ({ signal }) => api.bulkDeleteImpact(ids, signal),
  });
  const linked = impact.data?.records ?? [];
  const count = plural(ids.length, noun[0], noun[1]);
  async function remove() {
    setBusy(true);
    const gone = new Set<string>(),
      failed: { id: string; message: string }[] = [];
    for (const [i, id] of ids.entries()) {
      setProgress(i);
      // An earlier delete may already have cascaded to this one.
      if (gone.has(id)) continue;
      try {
        const result = await api.deleteRecord(id);
        for (const other of result.deletedRecordIds) gone.add(other);
      } catch (e) {
        // Someone else deleted it meanwhile: it is gone either way.
        if (e instanceof RetainerApiError && (e.status === 404 || e.code === 'record_deleted'))
          gone.add(id);
        else failed.push({ id, message: (e as Error).message });
      }
    }
    const deleted = ids.filter((id) => gone.has(id));
    const cascaded = gone.size - deleted.length;
    const wid = session.workspace.id;
    for (const id of gone) client.removeQueries({ queryKey: [wid, 'record', id] });
    void client.invalidateQueries({ queryKey: [wid] });
    report(
      <Stack>
        <span>
          Deleted {plural(deleted.length, noun[0], noun[1])}
          {cascaded ? ` and ${plural(cascaded, 'linked record', 'linked records')}` : ''}.
        </span>
        {failed.length ? (
          <span>
            {plural(failed.length, 'record was', 'records were')} not deleted and{' '}
            {failed.length === 1 ? 'stays' : 'stay'} selected: {failed[0]?.message}
          </span>
        ) : null}
      </Stack>,
    );
    onDone(
      failed.map((f) => f.id),
      deleted,
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Delete ${count}?`}
      description="They disappear from lists, search and the records that link to them. Their history stays stored, but they can’t be restored from the app."
    >
      <Stack>
        {impact.error ? (
          <QueryError error={impact.error} retry={() => void impact.refetch()} />
        ) : null}
        {impact.isPending ? <Notice>Checking linked records…</Notice> : null}
        {linked.length ? (
          <Notice error>
            Deleting them also deletes {describeImpact(linked, schema.objects)} linked to them.
          </Notice>
        ) : null}
        <Row>
          <Button
            variant="destructive"
            disabled={busy || !impact.data}
            onClick={() => void remove()}
          >
            {busy ? `Deleting… ${progress} of ${ids.length}` : `Delete ${count}`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

/** The hard delete for a privacy request (ARCHITECTURE.md 2.1). */
function ForgetDialog({ record, onClose, onGone }: ActionProps) {
  const report = useReport();
  const [typed, setTyped] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const word = forgetConfirmation(record);
  async function erase() {
    if (typed.trim() !== word || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.forget(record.id);
      report(<ForgetReport label={title(record)} result={result} />);
      onGone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Erase ${title(record)} permanently?`}
      description="For privacy requests. Unlike delete, nothing is kept and nothing can be restored."
    >
      <Form onSubmit={() => void erase()}>
        {error ? <Notice error>{error}</Notice> : null}
        <Stack>
          <Muted>This erases, for good:</Muted>
          <Muted>· the record and any records merged into it, with their history and facts;</Muted>
          <Muted>· every event they took part in, whole, including what others said in it;</Muted>
          <Muted>· values and facts on other records that came only from those events.</Muted>
          <Muted>
            Their emails and phones are blocked, so no record can add them again. Other records may
            still mention them; you’ll get a list to check.
          </Muted>
        </Stack>
        <FormField label={`Type “${word}” to confirm`}>
          <Input
            aria-label="Confirmation"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </FormField>
        <Row>
          <Button type="submit" variant="destructive" disabled={busy || typed.trim() !== word}>
            {busy ? 'Erasing…' : 'Erase permanently'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Form>
    </Dialog>
  );
}

const SHOWN = 10;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What `forget` removed, and the live rows that may still mention the person. */
function ForgetReport({ label, result }: { label: string; result: ForgetResult }) {
  const { session } = useWorkspace();
  const deletionIds = result.storage?.deletionIds;
  const storage = useQuery({
    queryKey: [session.workspace.id, 'file-erasure', deletionIds],
    queryFn: () => api.fileErasureStatus(deletionIds ?? []),
    enabled: !!deletionIds?.length,
    refetchInterval: (q) => (q.state.data?.pending === 0 ? false : 3000),
  });
  const pending = storage.data?.pending ?? result.storage?.pending ?? 0;
  const { counts, reviewCandidates: c } = result;
  const linked = [
    ...c.records.map((id) => <CandidateRecord key={id} id={id} />),
    ...c.events.map((id) => <CandidateEvent key={id} id={id} />),
  ];
  return (
    <Stack>
      <span>
        {pending ? 'Erasure in progress for' : 'Erased'} {label}:{' '}
        {plural(counts.records, 'record', 'records')}, {plural(counts.events, 'event', 'events')},{' '}
        {plural(counts.facts, 'fact', 'facts')} and {plural(counts.assertions, 'value', 'values')}.{' '}
        {plural(counts.suppressedHandles, 'email or phone is', 'emails and phones are')} blocked
        from coming back.
      </span>
      {pending ? (
        <Notice>
          File access has been revoked. {pending} storage deletions are pending. Previously issued
          download links expire within 60 seconds.
        </Notice>
      ) : result.storage ? (
        <Muted>File storage erasure is complete.</Muted>
      ) : null}
      {storage.error ? <Notice>Storage erasure status is temporarily unavailable.</Notice> : null}
      {linked.length || c.facts.length ? (
        <Stack>
          <span>These may still mention them. Check each one:</span>
          <Row>{linked.slice(0, SHOWN)}</Row>
          {linked.length > SHOWN ? <span>And {linked.length - SHOWN} more.</span> : null}
          {c.facts.length ? (
            <span>
              {plural(c.facts.length, 'fact', 'facts')} on other records{' '}
              {c.facts.length === 1 ? 'matches' : 'match'} their name or contact details.
            </span>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
/**
 * A link to a record by ID. With `references` (a page's map of the records it
 * names) it is named from the map, and a record missing from it shows as
 * unavailable; without one, its label is fetched.
 */
export function CandidateRecord({
  id,
  references,
}: {
  id: string;
  references?: Record<string, RecordReference>;
}) {
  if (!references) return <FetchedRecord id={id} />;
  const reference = references[id];
  return reference ? (
    <RecordLink id={id}>{title(reference)}</RecordLink>
  ) : (
    <Muted>Unavailable record</Muted>
  );
}
function FetchedRecord({ id }: { id: string }) {
  const record = useRecordLabel(id);
  return <RecordLink id={id}>{record.data ? title(record.data) : 'Record'}</RecordLink>;
}
function CandidateEvent({ id }: { id: string }) {
  const { session } = useWorkspace();
  const event = useQuery({
    queryKey: [session.workspace.id, 'event', id],
    queryFn: ({ signal }) => api.event(id, signal),
  });
  return <EventLink id={id}>{eventTitle({ title: event.data?.event?.title ?? null })}</EventLink>;
}
