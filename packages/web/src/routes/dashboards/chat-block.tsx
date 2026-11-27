import { RetainerApiError } from '@retainer/sdk';
import type { DashboardSummary, SavedDashboard } from '@retainer/shared';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Pin } from 'lucide-react';
import { useMemo } from 'react';
import { api, hasScope, useWorkspace } from '../../api/client.js';
import { Button, Notice } from '../../ui/index.js';
import { DraftCard } from '../agent/draft-card.js';
import { DashboardView } from './dashboard-view.js';
import { dashboardKey } from './keys.js';
import { mergeDashboardBlocks, programTitle, sameDashboardProgram } from './program.js';

type Target = Pick<DashboardSummary, 'id' | 'name' | 'updatedAt'>;
export type DashboardChatSearch = { dashboard?: string; dashboardRevision?: string };

function KeepButtons({ program, chatId }: { program: string; chatId: string }) {
  const { session } = useWorkspace();
  const base = dashboardKey(session.workspace.id);
  const client = useQueryClient();
  const search = useSearch({ strict: false }) as DashboardChatSearch;
  const linked = useQuery({
    queryKey: [...base, 'chat', chatId],
    queryFn: ({ signal }) => api.dashboards(chatId, signal),
    staleTime: Infinity,
  });
  const newest = linked.data?.dashboards.reduce<DashboardSummary | undefined>(
    (latest, dashboard) => (!latest || latest.updatedAt < dashboard.updatedAt ? dashboard : latest),
    undefined,
  );
  const dashboardId = newest?.id ?? search.dashboard;
  const opened = useQuery({
    queryKey: [...base, 'detail', dashboardId],
    queryFn: dashboardId ? ({ signal }) => api.dashboard(dashboardId, signal) : skipToken,
  });
  const target: Target | undefined =
    newest ??
    (opened.data && search.dashboardRevision
      ? { id: opened.data.id, updatedAt: search.dashboardRevision, name: opened.data.name }
      : undefined);
  const waiting = linked.isPending || (!!dashboardId && opened.isLoading);
  const name = programTitle(program);
  const save = useMutation({
    mutationFn: (target?: Target) =>
      target
        ? api.updateDashboard(target.id, { program, chatId, expectedUpdatedAt: target.updatedAt })
        : api.createDashboard({ name, program, chatId }),
    onSuccess: (dashboard: SavedDashboard) => {
      client.setQueryData([...base, 'detail', dashboard.id], dashboard);
      void client.invalidateQueries({ queryKey: [...base, 'list'] });
      void client.invalidateQueries({ queryKey: [...base, 'chat', chatId] });
    },
  });

  const savedId =
    save.data?.id ??
    (newest && opened.data && sameDashboardProgram(program, opened.data.program)
      ? newest.id
      : undefined);
  if (savedId)
    return (
      <Link
        className="text-sm text-primary underline"
        to="/dashboards/$id"
        params={{ id: savedId }}
      >
        Saved
      </Link>
    );
  const updateFirst = target?.name === name;
  return (
    <>
      {save.error ? (
        <Notice error>
          {save.error.message}
          {save.error instanceof RetainerApiError &&
          save.error.code === 'invalid_dashboard' &&
          Array.isArray(save.error.details?.problems) ? (
            <ul className="list-disc ps-4">
              {(save.error.details.problems as { statement: string; message: string }[]).map(
                ({ statement, message }) => (
                  <li key={`${statement}-${message}`}>
                    {statement} — {message}
                  </li>
                ),
              )}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {target && (
        <Button
          size="small"
          variant={updateFirst ? 'primary' : 'outline'}
          disabled={waiting || save.isPending}
          onClick={() => save.mutate(target)}
        >
          Update “{target.name}”
        </Button>
      )}
      <Button
        size="small"
        variant={updateFirst ? 'outline' : 'primary'}
        disabled={waiting || save.isPending}
        onClick={() => save.mutate(undefined)}
      >
        <Pin size={14} /> {updateFirst ? 'Save as new' : 'Pin to Dashboards'}
      </Button>
    </>
  );
}

export default function DashboardChatBlock({
  code,
  previous,
  streaming,
  complete,
  chatId,
}: {
  code: string;
  previous: string[];
  streaming: boolean;
  complete: boolean;
  chatId?: string | undefined;
}) {
  const { session } = useWorkspace();
  const program = useMemo(() => {
    try {
      return mergeDashboardBlocks(previous, code);
    } catch {
      return code;
    }
  }, [previous, code]);
  if (!program.trim() && streaming)
    return <p className="text-xs text-muted-foreground">Building dashboard…</p>;
  return (
    <DraftCard
      notice={
        !complete && !streaming ? (
          <p className="text-sm text-muted-foreground">This dashboard draft is incomplete.</p>
        ) : null
      }
      actions={
        complete && !streaming && chatId && hasScope(session, 'write') ? (
          <KeepButtons program={program} chatId={chatId} />
        ) : null
      }
    >
      <DashboardView program={program} streaming={streaming && !complete} />
    </DraftCard>
  );
}
