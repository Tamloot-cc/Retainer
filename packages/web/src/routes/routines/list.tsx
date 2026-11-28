import type { RoutineView } from '@retainer/shared';
import { MessageSquarePlus, Workflow } from 'lucide-react';
import { canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Empty,
  IdentityTag,
  ItemCard,
  ItemCards,
  Loading,
  Muted,
  Notice,
  Page,
  Stack,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
import { useRoutineChat } from './agent-chat.js';
import { errorText, routineStatus, useRoutines } from './model.js';
import { TimeZoneLine } from './time-zone.js';

/**
 * Routines (routines spec §5): the workspace's routines, each opening its
 * own page. A routine is built in the chat (routines-in-chat spec §8).
 */
export function RoutinesPage() {
  const { session } = useWorkspace();
  const routines = useRoutines();
  const chat = useRoutineChat();
  const canBuild = canMutate(session);
  const inChat = canBuild && session.agentAvailable === true;
  const all = routines.data?.routines ?? [];
  const live = all.filter((r) => r.status !== 'archived');
  const archived = all.filter((r) => r.status === 'archived');
  return (
    <Page
      title="Routines"
      description="A routine is a standing instruction: when something happens, Retainer does what you described. You describe it to the agent in the chat, it writes a small program and dry-runs it, and an admin approves it before it runs."
      actions={
        inChat ? (
          <Button disabled={chat.isPending} onClick={() => chat.mutate(undefined)}>
            <MessageSquarePlus size={14} /> New routine
          </Button>
        ) : undefined
      }
    >
      <Stack>
        {chat.error ? <Notice error>{errorText(chat.error, 'start a chat')}</Notice> : null}
        {canBuild && !inChat ? (
          <Muted>
            This server has no workspace agent, so routines are built by an agent you connect over
            MCP. It reads get_guide("routines") and proposes the routine for an admin to approve.
          </Muted>
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
              inChat
                ? 'Press New routine and describe what should happen.'
                : canBuild
                  ? 'Connect an agent over MCP to build one.'
                  : 'A person with write access can build one.'
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
