import { RetainerApiError } from '@retainer/sdk';
import { type SavedDashboard, sameActor, type UpdateDashboard } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Ellipsis, LayoutDashboard } from 'lucide-react';
import { lazy, Suspense, useId, useState } from 'react';
import { api, hasScope, useWorkspace } from '../../api/client.js';
import {
  Button,
  Dialog,
  Empty,
  Input,
  Loading,
  Notice,
  Page,
  RelativeTime,
} from '../../ui/index.js';
import { Menu, MenuAction } from '../../ui/menu.js';
import { firstMessages } from '../agent/first-message.js';
import { QueryError } from '../state.js';
import { dashboardKey } from './keys.js';

const DashboardView = lazy(() =>
  import('./dashboard-view.js').then(({ DashboardView }) => ({ default: DashboardView })),
);

export function DashboardsPage() {
  const { session } = useWorkspace();
  const list = useQuery({
    queryKey: [...dashboardKey(session.workspace.id), 'list'],
    queryFn: ({ signal }) => api.dashboards(undefined, signal),
  });
  return (
    <Page title="Dashboards" icon={<LayoutDashboard size={16} />}>
      {list.error ? (
        <QueryError error={list.error} retry={() => void list.refetch()} />
      ) : !list.data ? (
        <Loading>Loading dashboards…</Loading>
      ) : !list.data.dashboards.length ? (
        <div className="flex flex-col items-center gap-3">
          <Empty
            title="No dashboards yet"
            description="Ask the agent for one, such as ‘deals by stage this quarter’, then pin it."
          />
          <Button asChild>
            <Link to="/chat">Open chat</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.data.dashboards.map((dashboard) => (
            <li key={dashboard.id}>
              <Link
                to="/dashboards/$id"
                params={{ id: dashboard.id }}
                className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
              >
                <LayoutDashboard size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                  {dashboard.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {dashboard.visibility === 'workspace' ? 'Shared' : 'Private'}
                </span>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  <RelativeTime at={dashboard.updatedAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function firstDashboardMessage(dashboard: SavedDashboard) {
  const backticks = dashboard.program.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...backticks.map((run) => run.length + 1)));
  const issues = dashboard.issues
    .map(({ statement, message }) => `- ${statement}: ${message}`)
    .join('\n');
  return [
    issues
      ? `Fix my dashboard "${dashboard.name}". These queries need attention:\n${issues}`
      : `I'd like to change my dashboard "${dashboard.name}". Use this saved program as the starting point and ask me what to change.`,
    `${fence}openui-lang\n${dashboard.program}\n${fence}`,
  ].join('\n\n');
}

function DashboardDetail({ dashboard }: { dashboard: SavedDashboard }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const base = dashboardKey(session.workspace.id);
  const detail = [...base, 'detail', dashboard.id];
  const editable = hasScope(session, 'write');
  const owned = sameActor(session.actor, dashboard.createdBy);
  const [dialog, setDialog] = useState<'rename' | 'delete'>();
  const [draft, setDraft] = useState('');
  const nameField = useId();
  const [renameRevision, setRenameRevision] = useState('');
  const openChat = useMutation({
    mutationFn: async () => {
      if (dashboard.chatId && !dashboard.issues.length) {
        try {
          const [, linked] = await Promise.all([
            api.agentChat(dashboard.chatId),
            api.dashboards(dashboard.chatId),
          ]);
          if (
            linked.dashboards.some(
              (other) => other.id !== dashboard.id && other.updatedAt >= dashboard.updatedAt,
            )
          )
            firstMessages.set(dashboard.chatId, firstDashboardMessage(dashboard));
          return dashboard.chatId;
        } catch (error) {
          if (!(error instanceof RetainerApiError) || error.status !== 404) throw error;
        }
      }
      const chat = await api.createAgentChat(undefined, 'web');
      firstMessages.set(chat.id, firstDashboardMessage(dashboard));
      return chat.id;
    },
    onSuccess: (id) => {
      void navigate({
        to: '/chat/$id',
        params: { id },
        search: {
          dashboard: dashboard.id,
          dashboardRevision: dashboard.updatedAt,
        },
      });
    },
  });
  const change = useMutation({
    mutationFn: (input: Omit<UpdateDashboard, 'expectedUpdatedAt'>) =>
      api.updateDashboard(dashboard.id, {
        ...input,
        expectedUpdatedAt: dialog === 'rename' ? renameRevision : dashboard.updatedAt,
      }),
    onSuccess: (updated) => {
      client.setQueryData(detail, updated);
      void client.invalidateQueries({ queryKey: [...base, 'list'] });
      if (updated.chatId)
        void client.invalidateQueries({ queryKey: [...base, 'chat', updated.chatId] });
      setDialog(undefined);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDashboard(dashboard.id),
    onSuccess: async () => {
      void client.invalidateQueries({ queryKey: [...base, 'list'] });
      await navigate({ to: '/dashboards' });
      client.removeQueries({ queryKey: detail });
    },
  });
  const error = openChat.error ?? change.error ?? remove.error;
  const busy = change.isPending || remove.isPending;
  const close = () => {
    if (busy) return;
    change.reset();
    remove.reset();
    setDialog(undefined);
  };
  return (
    <Page
      title={dashboard.name}
      eyebrow="Dashboards"
      eyebrowLink={{ to: '/dashboards' }}
      actions={
        <>
          <Button
            variant="outline"
            size="small"
            disabled={openChat.isPending}
            onClick={() => openChat.mutate()}
          >
            {dashboard.issues.length ? 'Fix with the agent' : 'Edit with the agent'}
          </Button>
          {editable ? (
            <Menu
              label="Dashboard actions"
              align="end"
              trigger={
                <Button
                  variant="ghost"
                  size="iconSmall"
                  aria-label="Dashboard actions"
                  disabled={busy}
                >
                  <Ellipsis size={16} />
                </Button>
              }
            >
              {owned ? (
                <MenuAction
                  onSelect={() =>
                    change.mutate({
                      visibility: dashboard.visibility === 'private' ? 'workspace' : 'private',
                    })
                  }
                >
                  {dashboard.visibility === 'private' ? 'Share with workspace' : 'Make private'}
                </MenuAction>
              ) : null}
              <MenuAction
                onSelect={() => {
                  change.reset();
                  setDraft(dashboard.name);
                  setRenameRevision(dashboard.updatedAt);
                  setDialog('rename');
                }}
              >
                Rename
              </MenuAction>
              <MenuAction
                destructive
                onSelect={() => {
                  remove.reset();
                  setDialog('delete');
                }}
              >
                Delete
              </MenuAction>
            </Menu>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Created by {dashboard.createdBy.name ?? dashboard.createdBy.id} ·{' '}
          {dashboard.visibility === 'workspace' ? 'Shared with workspace' : 'Private'}
        </p>
        {error && !dialog ? <Notice error>{error.message}</Notice> : null}
        <Suspense fallback={<Loading>Loading dashboard…</Loading>}>
          <DashboardView saved program={dashboard.program} issues={dashboard.issues} />
        </Suspense>
      </div>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={dialog === 'delete' ? 'Delete dashboard?' : 'Rename dashboard'}
        closeDisabled={busy}
        description={
          dialog === 'delete' ? `“${dashboard.name}” will be removed from Dashboards.` : undefined
        }
      >
        {error ? <Notice error>{error.message}</Notice> : null}
        {dialog === 'rename' ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim()) change.mutate({ name: draft.trim() });
            }}
          >
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={nameField}>Name</label>
              <Input
                id={nameField}
                value={draft}
                maxLength={100}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
                Rename
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={busy}>
              Delete dashboard
            </Button>
          </div>
        )}
      </Dialog>
    </Page>
  );
}

export function DashboardPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session } = useWorkspace();
  const dashboard = useQuery({
    queryKey: [...dashboardKey(session.workspace.id), 'detail', id],
    queryFn: ({ signal }) => api.dashboard(id, signal),
  });
  if (!dashboard.data)
    return (
      <Page title="Dashboard" eyebrow="Dashboards" eyebrowLink={{ to: '/dashboards' }}>
        {dashboard.error ? (
          <QueryError error={dashboard.error} retry={() => void dashboard.refetch()} />
        ) : (
          <Loading>Loading dashboard…</Loading>
        )}
      </Page>
    );
  return <DashboardDetail key={id} dashboard={dashboard.data} />;
}
