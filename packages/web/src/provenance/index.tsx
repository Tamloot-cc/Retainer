import type { Actor, AssertionView, FactSource, FieldView, Provenance } from '@retainer/shared';
import { Bot, Cog, Plug, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWorkspace } from '../api/client.js';
import { fields } from '../fields/index.js';
import { eventTitle, objectLabel } from '../routes/state.js';
import { objectColor } from '../ui/colors.js';
import {
  EntryQuote,
  EventLink,
  IdentityTag,
  Muted,
  ObjectIcon,
  ReviewLink,
  Row,
  Sourced,
  Stack,
  Tooltip,
} from '../ui/index.js';
export function ActorBadge({ actor }: { actor: Actor }) {
  const Icon = { agent: Bot, user: UserRound, integration: Plug, system: Cog }[actor.type];
  return (
    <IdentityTag identity={`actor:${actor.type}:${actor.id}`}>
      <Icon size={12} aria-hidden className="shrink-0" />
      <span className="truncate" title={actor.name || actor.id}>
        {actor.name || actor.id}
      </span>
      <span className="shrink-0">· {actor.type}</span>
    </IdentityTag>
  );
}
/** What a fact rests on: the internal note, or each source event with its quote. */
export function FactSources({ sources }: { sources: FactSource[] }) {
  return sources.map((s) =>
    s.internal ? (
      <Muted key="internal" small>
        Internal note
      </Muted>
    ) : (
      <Stack key={s.event} gap="small">
        <EventLink id={s.event}>Source event</EventLink>
        {s.quote ? <EntryQuote>{s.quote}</EntryQuote> : null}
      </Stack>
    ),
  );
}
export function AssertionSource({ assertion }: { assertion: AssertionView }) {
  const { schema } = useWorkspace();
  return (
    <Stack>
      <ActorBadge actor={assertion.actor} />
      <Muted>Observed {new Date(assertion.observedAt).toLocaleString()}</Muted>
      {assertion.source ? (
        <Row>
          <SourceBadge
            type={assertion.source.type}
            label={objectLabel(schema, assertion.source.type)}
          />
          <EventLink id={assertion.source.id}>
            {eventTitle(assertion.source)} ·{' '}
            {new Date(assertion.source.occurredAt).toLocaleDateString()}
          </EventLink>
        </Row>
      ) : (
        <Muted>
          {assertion.sourceRecordId ? 'Source event no longer available' : 'No source event'}
        </Muted>
      )}
      {assertion.isInitial ? <Muted>Recorded when the event was logged</Muted> : null}
      {assertion.reviewedBy ? (
        <Row>
          <Muted>Reviewed by</Muted>
          <ActorBadge actor={assertion.reviewedBy} />
        </Row>
      ) : null}
    </Stack>
  );
}
export function SourcedValue({
  provenance,
  viewer,
  field,
  children,
}: {
  provenance?: Provenance;
  viewer: Actor;
  field: FieldView;
  children: ReactNode;
}) {
  const a = provenance?.assertion;
  const other = a && (a.actor.type !== viewer.type || a.actor.id !== viewer.id);
  return (
    <Row>
      {other ? (
        <Tooltip content={<AssertionSource assertion={a} />}>
          <Sourced>{children}</Sourced>
        </Tooltip>
      ) : (
        children
      )}
      {provenance?.pendingAssertionIds.length ? (
        <Tooltip content={<PendingPreview field={field} assertion={provenance.pendingAssertion} />}>
          <ReviewLink
            id={provenance.pendingAssertion?.id ?? provenance.pendingAssertionIds[0] ?? ''}
          >
            Pending review
            {provenance.pendingAssertionIds.length > 1
              ? ` (${provenance.pendingAssertionIds.length})`
              : ''}
          </ReviewLink>
        </Tooltip>
      ) : null}
    </Row>
  );
}

function PendingPreview({
  field,
  assertion,
}: {
  field: FieldView;
  assertion?: AssertionView | null;
}) {
  const Display = fields[field.type].Display;
  return (
    <Stack>
      <Muted>Proposed value</Muted>
      {assertion ? (
        <Display field={field} value={assertion.value} references={assertion.relationReferences} />
      ) : (
        <Muted>Open the review item to see its proposal.</Muted>
      )}
    </Stack>
  );
}

export function SourceBadge({ type, label }: { type: string; label: string }) {
  return (
    <IdentityTag identity={type} color={objectColor(type)}>
      <ObjectIcon name={type} objectClass="event" size={12} />
      <span className="truncate" title={label}>
        {label}
      </span>
    </IdentityTag>
  );
}
