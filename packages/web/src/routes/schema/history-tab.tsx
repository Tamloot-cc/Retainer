import {
  SCHEMA_CHANGE_STATUSES,
  type SchemaChange,
  type SchemaChangeStatus,
} from '@retainer/shared';
import { Link } from '@tanstack/react-router';
import { CircleCheck, CircleX, Clock, type LucideIcon, TriangleAlert } from 'lucide-react';
import { canMutate, useWorkspace } from '../../api/client.js';
import { ActorBadge } from '../../provenance/index.js';
import {
  Badge,
  Button,
  Empty,
  IconLabel,
  Muted,
  Notice,
  Panel,
  Row,
  SelectMenu,
  Stack,
  Timeline,
  TimelineItem,
  type Tone,
} from '../../ui/index.js';
import { QueryError, useView } from '../state.js';
import { describeOperation, parseStatus, relativeTime, useSchemaChanges } from './schema-model.js';

const STATUS: Record<SchemaChangeStatus, { label: string; icon: LucideIcon; tone: Tone }> = {
  applied: { label: 'Applied', icon: CircleCheck, tone: 'success' },
  proposed: { label: 'Proposed', icon: Clock, tone: 'pending' },
  rejected: { label: 'Rejected', icon: CircleX, tone: 'neutral' },
  failed: { label: 'Failed', icon: TriangleAlert, tone: 'error' },
};

export function HistoryTab() {
  const { session } = useWorkspace(),
    { search, setSearch } = useView();
  const status = parseStatus(search.status);
  const changes = useSchemaChanges(status, search.cursor);
  const canAdmin = canMutate(session, 'admin');
  return (
    <Stack>
      <Row>
        <SelectMenu
          label="Status"
          value={status ?? ''}
          options={[
            { value: '', label: 'All statuses' },
            ...SCHEMA_CHANGE_STATUSES.map((s) => ({
              value: s,
              label: STATUS[s].label,
              content: <IconLabel icon={STATUS[s].icon}>{STATUS[s].label}</IconLabel>,
            })),
          ]}
          onChange={(next) => void setSearch({ status: next || undefined, cursor: undefined })}
        />
        {changes.data ? (
          <Muted>
            {changes.data.total} {changes.data.total === 1 ? 'change' : 'changes'}
          </Muted>
        ) : null}
      </Row>
      {changes.error ? (
        <QueryError error={changes.error} retry={() => void changes.refetch()} />
      ) : null}
      {changes.isPending ? <Notice>Loading history…</Notice> : null}
      {changes.data && !changes.data.changes.length ? (
        <Empty
          title={status ? `No ${STATUS[status].label.toLowerCase()} changes` : 'No changes yet'}
          description="Changes appear here when an agent proposes one or a template is applied."
        />
      ) : null}
      {changes.data?.changes.length ? (
        <Panel>
          <Timeline label="Schema changes">
            {changes.data.changes.map((c) => (
              <ChangeItem key={c.id} change={c} canDecide={canAdmin} />
            ))}
          </Timeline>
        </Panel>
      ) : null}
      {search.cursor || changes.data?.nextCursor ? (
        <Row>
          {search.cursor ? (
            <Button onClick={() => void setSearch({ cursor: undefined })}>Newest</Button>
          ) : null}
          {changes.data?.nextCursor ? (
            <Button
              onClick={() => void setSearch({ cursor: changes.data?.nextCursor ?? undefined })}
            >
              Older changes
            </Button>
          ) : null}
        </Row>
      ) : null}
    </Stack>
  );
}

function ChangeItem({ change, canDecide }: { change: SchemaChange; canDecide: boolean }) {
  const { objects } = useWorkspace().schema;
  const s = STATUS[change.status];
  return (
    <TimelineItem icon={s.icon} tone={s.tone}>
      <Row>
        <Badge tone={s.tone}>{s.label}</Badge>
        {change.appliedVersion ? <Muted>v{change.appliedVersion}</Muted> : null}
        {change.isDestructive ? <Badge>Destructive</Badge> : null}
        <Muted>
          <time dateTime={change.createdAt} title={new Date(change.createdAt).toLocaleString()}>
            {relativeTime(change.createdAt)}
          </time>
        </Muted>
      </Row>
      {change.request.map((op, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a change's operations never reorder.
        <div key={i}>{describeOperation(op, objects)}</div>
      ))}
      {change.reason ? <Muted>“{change.reason}”</Muted> : null}
      <Row>
        <Muted>By</Muted>
        <ActorBadge actor={change.requestedBy} />
        {change.decidedBy ? (
          <>
            <Muted>{change.status === 'rejected' ? 'rejected by' : 'approved by'}</Muted>
            <ActorBadge actor={change.decidedBy} />
          </>
        ) : null}
      </Row>
      {change.error ? <Notice error>{change.error}</Notice> : null}
      {canDecide && change.status === 'proposed' ? (
        <Row>
          <Button size="small" asChild>
            <Link to="/review" search={{ tab: 'schema' }}>
              Review in inbox
            </Link>
          </Button>
        </Row>
      ) : null}
    </TimelineItem>
  );
}
