import { RetainerApiError } from '@retainer/sdk';
import { type SavedDashboard, sameActor, type UpdateDashboard } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Ellipsis, LayoutDashboard, MessageSquarePlus } from 'lucide-react';
import { lazy, Suspense, useId, useState } from 'react';
import { api, hasScope, useWorkspace } from '../../api/client.js';
import { actorLabel } from '../../provenance/index.js';
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
import { type BlockHistory, extendMessageBlockHistory } from '../agent/chat-blocks.js';
import { canStart } from '../agent/chats-search.js';
import { firstMessages } from '../agent/first-message.js';
import { agentKey, type ChatMessage } from '../agent/model.js';
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
  const canBuild = canStart('dashboard', session);
  return (
    <Page
      title="Dashboards"
      icon={<LayoutDashboard size={16} />}
      actions={
        canBuild ? (
          <Button asChild>
            <Link to="/chat" search={{ new: 'dashboard' }}>
              <MessageSquarePlus size={14} /> New dashboard
            </Link>
          </Button>
        ) : undefined
      }
    >
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
            {/* A reader can still ask about dashboards, in a plain chat. */}
            {canBuild ? (
              <Link to="/chat" search={{ new: 'dashboard' }}>
                Open chat
              </Link>
            ) : (
              <Link to="/chat">Open chat</Link>
            )}
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
      // The detail cache can still contain a program read before a schema rename.
      const current = await api.dashboard(dashboard.id);
      client.setQueryData(detail, current);
      if (current.chatId && !current.issues.length) {
        try {
          const [chat, { matchesDashboardHistory }] = await Promise.all([
            api.agentChat(current.chatId),
            import('./program.js'),
          ]);
          // The chat page reads this instead of downloading the chat again.
          client.setQueryData([...agentKey(session.workspace.id), 'chat', chat.id], chat);
          const history = (chat.messages as ChatMessage[]).reduce<BlockHistory>(
            (blocks, message) => extendMessageBlockHistory(blocks, message),
            {},
          );
          if (!matchesDashboardHistory(history['openui-lang'] ?? [], current.program))
            firstMessages.set(chat.id, firstDashboardMessage(current));
          return { chatId: chat.id, current };
        } catch (error) {
          if (!(error instanceof RetainerApiError) || error.status !== 404) throw error;
        }
      }
      const chat = await api.createAgentChat(undefined, 'web');
      firstMessages.set(chat.id, firstDashboardMessage(current));
      return { chatId: chat.id, current };
    },
    onSuccess: ({ chatId, current }) => {
      void navigate({
        to: '/chat/$id',
        params: { id: chatId },
        search: {
          dashboard: current.id,
          dashboardRevision: current.updatedAt,
        },
      });
    },
  });
  const change = useMutation({
    mutationFn: (input: UpdateDashboard) => api.updateDashboard(dashboard.id, input),
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
                      expectedUpdatedAt: dashboard.updatedAt,
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
          Created by {actorLabel(dashboard.createdBy)} ·{' '}
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
              if (draft.trim())
                change.mutate({ name: draft.trim(), expectedUpdatedAt: renameRevision });
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
