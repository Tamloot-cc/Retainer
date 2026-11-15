import type { RetainerApiError } from '@retainer/sdk';
import type { AssertionView, ReviewCollection, SchemaChange } from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { ActorBadge } from '../../provenance/index.js';
import { objectColor } from '../../ui/colors.js';
import {
  Badge,
  Button,
  Empty,
  EventLink,
  IdentityTag,
  Input,
  Muted,
  Notice,
  ObjectIcon,
  Page,
  Panel,
  RecordAvatar,
  RecordLink,
  Row,
  Stack,
  Tabs,
} from '../../ui/index.js';
import { MergeSuggestionCard } from '../records/merge.js';
import { CandidateRecord } from '../records/record-actions.js';
import { describeOperation, useSchemaChanges } from '../schema/schema-model.js';
import { eventTitle, objectByName, QueryError, recordTitle, useView } from '../state.js';

const reasonText = {
  outranked: 'Newer than a value a person or integration set',
  low_confidence: 'Below the workspace’s confidence threshold',
  unique_conflict: 'Another record already has this value',
};
function SchemaChangeCard({
  change,
  onDecision,
  allowed,
  busy,
}: {
  change: SchemaChange;
  onDecision: (id: string, decision: 'approve' | 'reject') => void;
  allowed: boolean;
  busy: boolean;
}) {
  const { objects } = useWorkspace().schema;
  return (
    <Panel>
      <Stack>
        <Row>
          <Badge tone="pending">{change.status}</Badge>
          <ActorBadge actor={change.requestedBy} />
          <Muted>{new Date(change.createdAt).toLocaleString()}</Muted>
        </Row>
        {change.request.map((op, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a change's operations never reorder.
          <div key={i}>{describeOperation(op, objects)}</div>
        ))}
        {change.reason ? <Muted>{change.reason}</Muted> : null}
        {change.error ? <Notice error>{change.error}</Notice> : null}
        {allowed ? (
          <Row>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onDecision(change.id, 'approve')}
            >
              Approve
            </Button>
            <Button disabled={busy} onClick={() => onDecision(change.id, 'reject')}>
              Reject
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Panel>
  );
}
type ReviewOutcome = {
  id: string;
  item?: AssertionView;
  text: string;
  conflictId?: string;
  current?: unknown;
  showCurrent?: boolean;
  failed?: boolean;
};
export function ReviewPage() {
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    { search, setSearch } = useView();
  const tab = [
    'pendingAssertions',
    'schema',
    'mergeSuggestions',
    'unresolvedParticipants',
  ].includes(search.tab ?? '')
    ? (search.tab ?? 'pendingAssertions')
    : 'pendingAssertions';
  const cursor = search.cursor;
  const wid = session.workspace.id;
  const review = useQuery({
    queryKey: [wid, 'review', tab, cursor],
    queryFn: ({ signal }) =>
      api.review({ limit: 50, ...(tab !== 'schema' ? { [`${tab}Cursor`]: cursor } : {}), signal }),
  });
  const changes = useSchemaChanges('proposed', tab === 'schema' ? cursor : undefined);
  const deep = useQuery({
    queryKey: [wid, 'assertion', search.assertion],
    queryFn: ({ signal }) => api.assertion(search.assertion ?? '', signal),
    enabled: !!search.assertion,
  });
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [messages, setMessages] = useState<string[]>([]),
    [blockingRecords, setBlockingRecords] = useState<string[]>([]),
    [outcomes, setOutcomes] = useState<ReviewOutcome[]>([]),
    [focus, setFocus] = useState(0);
  const canWrite = canMutate(session),
    canAdmin = canMutate(session, 'admin');
  const rows = review.data?.pendingAssertions ?? [];
  const pending =
    deep.data?.status === 'pending_review' && !rows.some((r) => r.id === deep.data?.id)
      ? [deep.data, ...rows]
      : rows;
  const refresh = () => client.invalidateQueries({ queryKey: [wid] });
  async function decide(ids: string[], decision: 'accept' | 'reject') {
    if (!canWrite || busy) return;
    setBusy(true);
    const results: ReviewOutcome[] = [];
    const failures: string[] = [];
    // Sequential calls are deliberately bounded to one in flight; each result is independent.
    for (const id of ids) {
      try {
        const result = await api.decideAssertion(id, decision);
        const item = pending.find((a) => a.id === id);
        const unchanged =
          result.status === 'accepted' &&
          Object.values(result.fields ?? {}).some((v) => v !== 'applied');
        results.push({
          id,
          item,
          text: unchanged
            ? 'Accepted; a newer value remains current'
            : decision === 'accept'
              ? 'Value accepted'
              : 'Value rejected',
          current: item ? result.record.fields[item.field] : undefined,
          showCurrent: unchanged,
        });
      } catch (error) {
        const e = error as RetainerApiError;
        results.push({
          id,
          item: pending.find((a) => a.id === id),
          text: e.code === 'not_pending' ? 'This item is no longer pending' : e.message,
          failed: e.code !== 'not_pending',
          conflictId:
            e.code === 'unique_conflict' && typeof e.details?.recordId === 'string'
              ? e.details.recordId
              : undefined,
        });
        if (e.code !== 'not_pending') failures.push(id);
      }
    }
    setSelected(failures);
    setOutcomes(results);
    setMessages([]);
    await refresh();
    setBusy(false);
  }
  async function decideSchema(id: string, decision: 'approve' | 'reject') {
    if (!canAdmin || busy) return;
    setBusy(true);
    try {
      const result = await api.decideSchemaChange(id, decision);
      // A failed approval keeps the engine's reason and, when it has them, the
      // records that stand in the way, such as those still holding a removed option.
      const reason = result.change?.error;
      setMessages([
        result.status === 'failed'
          ? `The schema change could not be applied${reason ? `: ${reason}` : ''}`
          : `Schema change ${decision === 'approve' ? 'approved' : 'rejected'}`,
      ]);
      setBlockingRecords(result.status === 'failed' ? (result.recordIds ?? []) : []);
    } catch (e) {
      setMessages([(e as Error).message]);
      setBlockingRecords([]);
    }
    await refresh();
    setBusy(false);
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        tab !== 'pendingAssertions' ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (e.target instanceof HTMLElement &&
          (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName) ||
            e.target.isContentEditable)) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const row = pending[Math.min(focus, pending.length - 1)];
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setFocus((n) => Math.max(0, Math.min(pending.length - 1, n + (e.key === 'j' ? 1 : -1))));
      }
      if (row && e.key === 'x') {
        e.preventDefault();
        setSelected((ids) =>
          ids.includes(row.id) ? ids.filter((id) => id !== row.id) : [...ids, row.id],
        );
      }
      if (row && (e.key === 'a' || e.key === 'r')) {
        e.preventDefault();
        void decide([row.id], e.key === 'a' ? 'accept' : 'reject');
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => {
    document.getElementById(`review-${pending[focus]?.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [focus, pending]);
  const next =
    tab === 'schema' ? changes.data?.nextCursor : review.data?.nextCursors[tab as ReviewCollection];
  return (
    <Page
      eyebrow="Human review"
      title="Review inbox"
      description="See what changed. Decide what stays."
      actions={<Muted>j / k move · x select · a accept · r reject</Muted>}
    >
      <Tabs
        value={tab}
        onChange={(tab) => {
          setSelected([]);
          setFocus(0);
          void setSearch({ tab, cursor: undefined, assertion: undefined });
        }}
        items={[
          {
            value: 'pendingAssertions',
            label: 'Pending values',
            count: review.data?.totals.pendingAssertions,
          },
          { value: 'schema', label: 'Schema changes', count: changes.data?.total },
          {
            value: 'mergeSuggestions',
            label: 'Suggested merges',
            count: review.data?.totals.mergeSuggestions,
          },
          {
            value: 'unresolvedParticipants',
            label: 'Unresolved participants',
            count: review.data?.totals.unresolvedParticipants,
          },
        ]}
      />
      {outcomes.map((outcome) => {
        const item = outcome.item;
        const field = item
          ? objectByName(schema, item.object)?.fields.find((f) => f.name === item.field)
          : undefined;
        const Display = field ? fields[field.type].Display : null;
        return (
          <Notice key={outcome.id} error={outcome.failed}>
            <Stack>
              <Row>
                {outcome.item ? (
                  <RecordLink id={outcome.item.recordId}>
                    {recordTitle({ label: outcome.item.recordLabel })} ·{' '}
                    {field?.label ?? outcome.item.field}
                  </RecordLink>
                ) : null}
                <span>{outcome.text}</span>
              </Row>
              {outcome.showCurrent && Display && field ? (
                <Row>
                  <Muted>Current value</Muted>
                  <Display field={field} value={outcome.current} />
                </Row>
              ) : null}
              {outcome.conflictId ? (
                <RecordLink id={outcome.conflictId}>View conflicting record</RecordLink>
              ) : null}
            </Stack>
          </Notice>
        );
      })}
      {messages.length ? (
        <Notice>
          {[...new Set(messages)].map((m) => (
            <div key={m}>{m}</div>
          ))}
          {blockingRecords.length ? (
            <Row>
              <span>Records in the way:</span>
              {blockingRecords.slice(0, 20).map((id) => (
                <CandidateRecord key={id} id={id} />
              ))}
              {blockingRecords.length > 20 ? (
                <Muted>and {blockingRecords.length - 20} more</Muted>
              ) : null}
            </Row>
          ) : null}
        </Notice>
      ) : null}
      {review.error ? (
        <QueryError error={review.error} retry={() => void review.refetch()} />
      ) : null}
      {changes.error ? (
        <QueryError error={changes.error} retry={() => void changes.refetch()} />
      ) : null}
      {deep.error ? <QueryError error={deep.error} /> : null}
      {deep.data && deep.data.status !== 'pending_review' ? (
        <Notice>The linked assertion is {deep.data.status}.</Notice>
      ) : null}
      {review.isPending || changes.isPending ? <Notice>Loading review items…</Notice> : null}
      {tab === 'pendingAssertions' ? (
        <Stack>
          {selected.length && canWrite ? (
            <Row>
              <Badge>{selected.length} selected</Badge>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void decide(selected, 'accept')}
              >
                Accept selected
              </Button>
              <Button disabled={busy} onClick={() => void decide(selected, 'reject')}>
                Reject selected
              </Button>
            </Row>
          ) : null}
          {pending.map((a, index) => {
            const field = objectByName(schema, a.object)?.fields.find((f) => f.name === a.field);
            const Display = field ? fields[field.type].Display : null;
            return (
              <div key={a.id} id={`review-${a.id}`}>
                <Panel title={index === focus ? 'Current item' : undefined}>
                  <Stack>
                    <Row>
                      <Input
                        type="checkbox"
                        aria-label={`Select ${a.recordLabel ?? a.recordId} ${a.field}`}
                        checked={selected.includes(a.id)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id),
                          )
                        }
                      />
                      <IdentityTag identity={a.object} color={objectColor(a.object)}>
                        <ObjectIcon name={a.object} size={12} />
                        {objectByName(schema, a.object)?.labelSingular ?? a.object}
                      </IdentityTag>
                      <RecordLink
                        id={a.recordId}
                        avatar={
                          <RecordAvatar
                            id={a.recordId}
                            name={recordTitle({ label: a.recordLabel })}
                            object={a.object}
                          />
                        }
                      >
                        {recordTitle({ label: a.recordLabel })}
                      </RecordLink>
                      <Muted>{field?.label ?? a.field}</Muted>
                    </Row>
                    <Row>
                      {Display && field ? (
                        <>
                          <Display
                            field={field}
                            value={a.currentValue}
                            references={a.relationReferences}
                          />
                          <Muted>→</Muted>
                          <Display
                            field={field}
                            value={a.value}
                            references={a.relationReferences}
                          />
                        </>
                      ) : (
                        <Muted>Field is no longer available</Muted>
                      )}
                    </Row>
                    <Row>
                      <ActorBadge actor={a.actor} />
                      <Badge tone="pending">
                        {a.reason ? reasonText[a.reason] : 'Pending review'}
                      </Badge>
                      <Muted>
                        {Math.round(a.confidence * 100)}% confidence ·{' '}
                        {new Date(a.observedAt).toLocaleString()}
                      </Muted>
                    </Row>
                    {a.conflictingRecord ? (
                      <RecordLink id={a.conflictingRecord.id}>
                        Conflicts with {a.conflictingRecord.label || a.conflictingRecord.id}
                      </RecordLink>
                    ) : null}
                    {a.source ? (
                      <EventLink id={a.source.id}>
                        {eventTitle(a.source)} ·{' '}
                        {new Date(a.source.occurredAt).toLocaleDateString()}
                      </EventLink>
                    ) : null}
                    {canWrite ? (
                      <Row>
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => void decide([a.id], 'accept')}
                        >
                          Accept
                        </Button>
                        <Button disabled={busy} onClick={() => void decide([a.id], 'reject')}>
                          Reject
                        </Button>
                      </Row>
                    ) : null}
                  </Stack>
                </Panel>
              </div>
            );
          })}
          {review.data && !pending.length ? (
            <Empty
              title="You're all caught up"
              description="Values that need your decision will appear here."
            />
          ) : null}
        </Stack>
      ) : null}
      {tab === 'schema' ? (
        <Stack>
          {changes.data?.changes.map((change) => (
            <SchemaChangeCard
              key={change.id}
              change={change}
              allowed={canAdmin}
              busy={busy}
              onDecision={(id, d) => void decideSchema(id, d)}
            />
          ))}
          {changes.data && !changes.data.changes.length ? (
            <Empty
              title="No schema changes to review"
              description="Agent proposals that need approval will appear here."
            />
          ) : null}
        </Stack>
      ) : null}
      {tab === 'mergeSuggestions' ? (
        <Stack>
          {review.data?.mergeSuggestions.map((suggestion) => (
            <MergeSuggestionCard key={suggestion.id} suggestion={suggestion} />
          ))}
          {review.data && !review.data.mergeSuggestions.length ? (
            <Empty
              title="No suggested merges"
              description="Records that look like duplicates of each other will appear here."
            />
          ) : null}
        </Stack>
      ) : null}
      {tab === 'unresolvedParticipants' ? (
        <Stack>
          {review.data?.unresolvedParticipants.map((p) => (
            <Panel key={`${p.eventId}:${p.position}`}>
              <Row>
                <Badge tone="pending">Deleted record</Badge>
                <span>{p.handle}</span>
                <EventLink id={p.eventId}>
                  {eventTitle(p)} · {new Date(p.occurredAt).toLocaleString()}
                </EventLink>
              </Row>
            </Panel>
          ))}
          {review.data && !review.data.unresolvedParticipants.length ? (
            <Empty title="No unresolved participants" />
          ) : null}
        </Stack>
      ) : null}
      <Row>
        {cursor ? (
          <Button onClick={() => void setSearch({ cursor: undefined })}>First page</Button>
        ) : null}
        {next ? <Button onClick={() => void setSearch({ cursor: next })}>Next page</Button> : null}
      </Row>
    </Page>
  );
}
