import type { MergeSuggestion, PresentedRecord } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import {
  Badge,
  Button,
  CheckLabel,
  Dialog,
  Input,
  Muted,
  Notice,
  RecordLink,
  Row,
  SelectMenu,
  Stack,
  Table,
  Td,
  Tr,
} from '../../ui/index.js';
import { ReviewActions, ReviewCard } from '../../ui/review.js';
import {
  objectByName,
  QueryError,
  recordTitle as title,
  useDebounced,
  useReport,
} from '../state.js';
import { useRecord } from './record-view.js';
import { defaultSurvivor, type MergeChoice, mergeRows, mergeValues } from './write-model.js';

/**
 * Compares two records of one object and merges one into the other. The
 * person picks which record survives (the older one by default) and, where
 * both have a value, which value stays; undecided fields follow the server's
 * rules. The dialog's idempotency key makes a retried merge safe.
 */
export function MergeDialog({
  ids,
  survivor: preferred,
  suggestion,
  onClose,
}: {
  ids: [string, string];
  /** The record that survives unless the person picks the other. */
  survivor?: string;
  /** The suggestion this merge answers, which can also be dismissed here. */
  suggestion?: string;
  onClose: () => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    report = useReport();
  const first = useRecord(ids[0]),
    second = useRecord(ids[1]);
  const [picked, setPicked] = useState<string>(),
    [choices, setChoices] = useState<Record<string, MergeChoice>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [key] = useState(() => crypto.randomUUID());
  const a = first.data,
    b = second.data;
  const loadError = first.error ?? second.error;
  const same = a && b && a.id === b.id;
  const keep =
    a && b
      ? ([a, b].find((r) => r.id === (picked ?? preferred)) ?? defaultSurvivor(a, b))
      : undefined;
  const away = keep && (keep === a ? b : a);
  const object = objectByName(schema, keep?.object);
  const rows = object && keep && away ? mergeRows(object, keep, away) : [];

  async function finish(message: ReactNode) {
    report(message);
    onClose();
    await client.invalidateQueries({ queryKey: [session.workspace.id] });
  }
  async function merge() {
    if (!keep || !away || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.mergeRecords(
        keep.id,
        { recordId: away.id, values: mergeValues(rows, choices) },
        key,
      );
      await finish(
        result.merged ? (
          <>
            Merged {title(away)} into <RecordLink id={result.id}>{title(result.record)}</RecordLink>
            .
          </>
        ) : (
          <>
            {title(away)} was already merged into{' '}
            <RecordLink id={result.id}>{title(result.record)}</RecordLink>.
          </>
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function dismiss() {
    if (!suggestion || busy) return;
    setBusy(true);
    try {
      await api.dismissMergeSuggestion(suggestion);
      await finish('Suggestion dismissed. These records won’t be suggested again.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Merge duplicate records"
      description="Everything the merged record holds moves to the record you keep: values, facts, events, history and links. Its old ID opens the kept record. A merge cannot be undone."
    >
      <Stack>
        {error ? <Notice error>{error}</Notice> : null}
        {loadError ? <QueryError error={loadError} /> : null}
        {!loadError && (!a || !b) ? <Notice>Loading records…</Notice> : null}
        {same ? <Notice>These are already one record.</Notice> : null}
        {keep && away && !same ? (
          <>
            <fieldset>
              <Stack>
                <Muted>Which record keeps its ID?</Muted>
                {[keep, away]
                  .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
                  .map((r) => (
                    <CheckLabel key={r.id}>
                      <Input
                        type="radio"
                        name="survivor"
                        checked={r.id === keep.id}
                        onChange={() => {
                          setPicked(r.id);
                          setChoices({});
                        }}
                      />
                      <span>
                        {title(r)} · created {new Date(r.createdAt).toLocaleString()}
                      </span>
                    </CheckLabel>
                  ))}
              </Stack>
            </fieldset>
            {rows.length ? (
              <Table
                headers={[
                  { label: 'Field' },
                  { label: `${title(keep)} (kept)` },
                  { label: `${title(away)} (merged)` },
                  { label: 'Result' },
                ]}
              >
                {rows.map((row) => {
                  const Display = fields[row.field.type].Display;
                  return (
                    <Tr key={row.field.name}>
                      <Td first>{row.field.label}</Td>
                      <Td>
                        <Display
                          field={row.field}
                          value={row.keep}
                          references={keep.relationReferences}
                          compact
                        />
                      </Td>
                      <Td>
                        <Display
                          field={row.field}
                          value={row.merge}
                          references={away.relationReferences}
                          compact
                        />
                      </Td>
                      <Td>
                        {row.conflict ? (
                          <SelectMenu
                            label={`Value for ${row.field.label}`}
                            size="small"
                            value={choices[row.field.name] ?? 'auto'}
                            options={[
                              {
                                value: 'auto',
                                label: row.combined ? 'Combine both' : 'Newest wins',
                              },
                              { value: 'keep', label: 'Kept record’s' },
                              { value: 'merge', label: 'Merged record’s' },
                            ]}
                            onChange={(next) =>
                              setChoices((c) => ({
                                ...c,
                                [row.field.name]: next as MergeChoice,
                              }))
                            }
                          />
                        ) : (
                          <Muted>Keeps the only value</Muted>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            ) : (
              <Muted>The two records hold the same values.</Muted>
            )}
            {rows.some((r) => r.conflict) ? (
              <Muted>
                “Newest wins” keeps the value observed last, unless a person or integration set the
                other one. Lists of emails, phones and links are combined.
              </Muted>
            ) : null}
          </>
        ) : null}
        <Row>
          <Button
            variant="destructive"
            disabled={busy || !keep || !away || !!same}
            onClick={() => void merge()}
          >
            {busy ? 'Merging…' : keep && away ? `Merge into ${title(keep)}` : 'Merge'}
          </Button>
          {suggestion ? (
            <Button disabled={busy} onClick={() => void dismiss()}>
              Not duplicates
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

/** One suggested pair in the review inbox. */
export function MergeSuggestionCard({ suggestion }: { suggestion: MergeSuggestion }) {
  const { session, schema } = useWorkspace();
  const [open, setOpen] = useState(false);
  const records = suggestion.recordIds.map((id) => suggestion.records.find((r) => r.id === id));
  const object = objectByName(schema, records[0]?.object);
  return (
    <ReviewCard>
      <Stack>
        <Row>
          <Badge tone="pending">{suggestion.reason}</Badge>
          {object ? <Badge>{object.labelSingular}</Badge> : null}
          <Muted>Suggested {new Date(suggestion.createdAt).toLocaleString()}</Muted>
        </Row>
        <Row>
          {records.map((r, i) =>
            r ? (
              <RecordLink key={r.id} id={r.id}>
                {title(r)}
              </RecordLink>
            ) : (
              <Muted key={suggestion.recordIds[i]}>Record unavailable</Muted>
            ),
          )}
        </Row>
        {canMutate(session) ? (
          <ReviewActions>
            <Button
              variant="primary"
              aria-label={`Compare and merge ${records.map((r) => (r ? title(r) : 'unavailable record')).join(' and ')}`}
              onClick={() => setOpen(true)}
            >
              Compare and merge
            </Button>
          </ReviewActions>
        ) : null}
      </Stack>
      {open ? (
        <MergeDialog
          ids={suggestion.recordIds}
          suggestion={suggestion.id}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </ReviewCard>
  );
}

/** Finds another record of the same object to merge into `record`. */
export function MergePicker({ record, onClose }: { record: PresentedRecord; onClose: () => void }) {
  const { session, schema } = useWorkspace();
  const object = objectByName(schema, record.object);
  const [search, setSearch] = useState(record.label ?? ''),
    [other, setOther] = useState<string>();
  const query = useDebounced(search.trim());
  const candidates = useQuery({
    queryKey: [session.workspace.id, 'mergeCandidates', record.object, query],
    queryFn: ({ signal }) =>
      api.queryRecords(record.object, { search: query || undefined, limit: 20 }, signal),
    enabled: !other,
    placeholderData: (previous) => previous,
  });
  if (other) return <MergeDialog ids={[record.id, other]} survivor={record.id} onClose={onClose} />;
  const list = candidates.data?.records.filter((r) => r.id !== record.id) ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Merge a duplicate into ${title(record)}`}
      description={`Find the other ${object?.labelSingular.toLowerCase() ?? 'record'}. You’ll compare the two before anything changes.`}
    >
      <Stack>
        <Input
          aria-label="Search records"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${object?.labelPlural.toLowerCase() ?? 'records'}…`}
        />
        {candidates.error ? <QueryError error={candidates.error} /> : null}
        {candidates.isFetching ? <Notice>Searching…</Notice> : null}
        {list.map((r) => (
          <Button key={r.id} onClick={() => setOther(r.id)}>
            {title(r)}
          </Button>
        ))}
        {candidates.data && !list.length ? <Muted>No other matching records.</Muted> : null}
      </Stack>
    </Dialog>
  );
}
