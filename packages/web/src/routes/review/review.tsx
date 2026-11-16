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
  RecordAvatar,
  RecordLink,
  Row,
  Stack,
} from '../../ui/index.js';
import {
  REVIEW_CATEGORIES,
  ReviewActions,
  ReviewCard,
  ReviewCategories,
  ReviewComparison,
  ReviewDetails,
  ReviewIntroduction,
  ReviewKeyboard,
  ReviewScroll,
  ReviewWelcome,
} from '../../ui/review.js';
import { MergeSuggestionCard } from '../records/merge.js';
import { CandidateRecord } from '../records/record-actions.js';
import { describeOperation, useSchemaChanges } from '../schema/schema-model.js';
import { eventTitle, objectByName, QueryError, recordTitle, useView } from '../state.js';

const reasonText = {
  outranked: 'A person or integration already set this field',
  low_confidence: 'The agent is not sure enough to apply this automatically',
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
    <ReviewCard>
      <Stack>
        <Row>
          <Badge tone="pending">Needs approval</Badge>
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
          <ReviewActions>
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
          </ReviewActions>
        ) : null}
      </Stack>
    </ReviewCard>
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
  const requestedTab = REVIEW_CATEGORIES.find((item) => item.value === search.tab)?.value;
  const tab = requestedTab ?? 'pendingAssertions';
  const cursor = search.cursor;
  const wid = session.workspace.id;
  const review = useQuery({
    queryKey: [wid, 'review', tab, cursor],
    queryFn: ({ signal }) =>
      api.review({ limit: 50, ...(tab !== 'schema' ? { [`${tab}Cursor`]: cursor } : {}), signal }),
  });
  const changes = useSchemaChanges('proposed', tab === 'schema' ? cursor : undefined);
  // Pick a starting category only after both fresh counts are ready, then pin it
  // in the URL so handling the last item never switches the person's context.
  useEffect(() => {
    if (
      requestedTab ||
      search.assertion ||
      !review.data ||
      !changes.data ||
      review.isFetching ||
      changes.isFetching
    )
      return;
    const counts = { ...review.data.totals, schema: changes.data.total };
    const first =
      REVIEW_CATEGORIES.find((item) => counts[item.value] > 0)?.value ?? 'pendingAssertions';
    void setSearch({ tab: first, cursor: undefined }, { replace: true });
  }, [
    requestedTab,
    search.assertion,
    review.data,
    changes.data,
    review.isFetching,
    changes.isFetching,
    setSearch,
  ]);
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
  const focused = Math.min(focus, Math.max(0, pending.length - 1));
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
          ? `The structure change could not be applied${reason ? `: ${reason}` : ''}`
          : `Structure change ${decision === 'approve' ? 'approved' : 'rejected'}`,
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
        !canWrite ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (e.target instanceof HTMLElement &&
          (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName) ||
            e.target.isContentEditable)) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const row = pending[focused];
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next = Math.max(0, Math.min(pending.length - 1, focused + (e.key === 'j' ? 1 : -1)));
        setFocus(next);
        document
          .getElementById(`review-${pending[next]?.id}`)
          ?.scrollIntoView({ block: 'nearest' });
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
  const next =
    tab === 'schema' ? changes.data?.nextCursor : review.data?.nextCursors[tab as ReviewCollection];
  return (
    <Page layout="fill" title="Review inbox">
      <ReviewScroll>
        <ReviewWelcome />
        <ReviewCategories
          value={tab}
          counts={{
            pendingAssertions: review.data?.totals.pendingAssertions,
            schema: changes.data?.total,
            mergeSuggestions: review.data?.totals.mergeSuggestions,
            unresolvedParticipants: review.data?.totals.unresolvedParticipants,
          }}
          onChange={(tab) => {
            setSelected([]);
            setFocus(0);
            setOutcomes([]);
            setMessages([]);
            setBlockingRecords([]);
            void setSearch({ tab, cursor: undefined, assertion: undefined });
          }}
        />
        <ReviewIntroduction category={tab} readOnly={tab === 'schema' ? !canAdmin : !canWrite} />
        {tab === 'pendingAssertions' && canWrite ? <ReviewKeyboard /> : null}
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
          <Notice>This suggestion is no longer waiting for review.</Notice>
        ) : null}
        {review.isPending || changes.isPending ? <Notice>Loading review items…</Notice> : null}
        {tab === 'pendingAssertions' ? (
          <Stack>
            {selected.length && canWrite ? (
              <Stack gap="small">
                <Row>
                  <Badge>{selected.length} selected</Badge>
                </Row>
                <ReviewActions>
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
                </ReviewActions>
              </Stack>
            ) : null}
            {pending.map((a, index) => {
              const field = objectByName(schema, a.object)?.fields.find((f) => f.name === a.field);
              const Display = field ? fields[field.type].Display : null;
              return (
                <div key={a.id} id={`review-${a.id}`}>
                  <ReviewCard active={index === focused}>
                    <Stack>
                      <Row>
                        {canWrite ? (
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
                        ) : null}
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
                      {Display && field ? (
                        <ReviewComparison
                          current={
                            <Display
                              field={field}
                              value={a.currentValue}
                              references={a.relationReferences}
                            />
                          }
                          proposed={
                            <Display
                              field={field}
                              value={a.value}
                              references={a.relationReferences}
                            />
                          }
                        />
                      ) : (
                        <Muted>Field is no longer available</Muted>
                      )}
                      {a.reason ? <Muted>{reasonText[a.reason]}</Muted> : null}
                      <ReviewDetails>
                        <ActorBadge actor={a.actor} />
                        <Muted>
                          {Math.round(a.confidence * 100)}% confidence ·{' '}
                          {new Date(a.observedAt).toLocaleString()}
                        </Muted>
                      </ReviewDetails>
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
                        <ReviewActions>
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
                        </ReviewActions>
                      ) : null}
                    </Stack>
                  </ReviewCard>
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
                title="No structure changes to review"
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
                title="No possible duplicates"
                description="Records that look like duplicates of each other will appear here."
              />
            ) : null}
          </Stack>
        ) : null}
        {tab === 'unresolvedParticipants' ? (
          <Stack>
            {review.data?.unresolvedParticipants.map((p) => (
              <ReviewCard key={`${p.eventId}:${p.position}`}>
                <Stack>
                  <ReviewDetails>
                    <Badge tone="pending">Deleted record</Badge>
                    <span>{p.handle || 'Participant without a saved name'}</span>
                  </ReviewDetails>
                  <Muted>We couldn’t link this participant to an active record.</Muted>
                  <EventLink id={p.eventId}>
                    Open activity: {eventTitle(p)} · {new Date(p.occurredAt).toLocaleDateString()}
                  </EventLink>
                </Stack>
              </ReviewCard>
            ))}
            {review.data && !review.data.unresolvedParticipants.length ? (
              <Empty title="No participant issues" />
            ) : null}
          </Stack>
        ) : null}
        <ReviewActions>
          {cursor ? (
            <Button onClick={() => void setSearch({ cursor: undefined })}>First page</Button>
          ) : null}
          {next ? (
            <Button onClick={() => void setSearch({ cursor: next })}>Next page</Button>
          ) : null}
        </ReviewActions>
      </ReviewScroll>
    </Page>
  );
}
