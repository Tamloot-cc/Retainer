import type { RoutineView } from '@retainer/shared';
import { Workflow } from 'lucide-react';
import { canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Empty,
  IdentityTag,
  ItemCard,
  ItemCards,
  Loading,
  Muted,
  Page,
  Panel,
  Stack,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
import { DescribeRoutine } from './describe.js';
import { routineStatus, useRoutines } from './model.js';
import { TimeZoneLine } from './time-zone.js';

/**
 * Routines (routines spec §5): describe one in plain words, then the
 * workspace's routines, each opening its own page.
 */
export function RoutinesPage() {
  const { session } = useWorkspace();
  const routines = useRoutines();
  const canBuild = canMutate(session);
  const all = routines.data?.routines ?? [];
  const live = all.filter((r) => r.status !== 'archived');
  const archived = all.filter((r) => r.status === 'archived');
  return (
    <Page
      title="Routines"
      description="A routine is a standing instruction: when something happens, Retainer does what you described. You describe it in plain words, the builder turns it into a small program, and an admin approves it before it runs."
    >
      <Stack>
        {canBuild ? (
          <Panel title="Describe a routine">
            <DescribeRoutine />
          </Panel>
        ) : null}
        <TimeZoneLine />
        {routines.error ? (
          <QueryError error={routines.error} retry={() => void routines.refetch()} />
        ) : !routines.data ? (
          <Loading>Loading routines…</Loading>
        ) : !all.length ? (
          <Empty
            title="No routines yet"
            description={
              canBuild
                ? 'Describe one above to get started.'
                : 'A person with write access can describe one.'
            }
          />
        ) : (
          <>
            {live.length ? (
              <ItemCards label="Routines">
                {live.map((routine) => (
                  <RoutineCard key={routine.id} routine={routine} />
                ))}
              </ItemCards>
            ) : null}
            {archived.length ? (
              <ItemCards label="Archived">
                {archived.map((routine) => (
                  <RoutineCard key={routine.id} routine={routine} />
                ))}
              </ItemCards>
            ) : null}
          </>
        )}
        {routines.data && all.some((r) => r.proposals) && !canMutate(session, 'admin') ? (
          <Muted>A workspace admin reviews and approves routines.</Muted>
        ) : null}
      </Stack>
    </Page>
  );
}

function RoutineCard({ routine }: { routine: RoutineView }) {
  const { label, tone } = routineStatus(routine.status);
  const version = routine.activeVersion;
  return (
    <ItemCard
      icon={
        <IdentityTag identity={routine.id}>
          <Workflow size={18} />
        </IdentityTag>
      }
      title={routine.name}
      status={
        <>
          <Badge tone={tone}>{label}</Badge>
          {routine.proposals ? (
            <Badge tone="pending">
              {routine.proposals === 1
                ? 'A version waits for review'
                : `${routine.proposals} versions wait for review`}
            </Badge>
          ) : null}
          {routine.heldRuns ? (
            <Badge tone="pending">
              {routine.heldRuns === 1 ? '1 run held' : `${routine.heldRuns} runs held`}
            </Badge>
          ) : null}
        </>
      }
      description={version ? version.facts.join(' ') || version.summary : routine.description}
      link={{ to: '/routines/$id', params: { id: routine.id } }}
    />
  );
}
