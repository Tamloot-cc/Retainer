import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { account as accountApi, type Connection } from '../api/account.js';
import { QueryError } from '../routes/state.js';
import { Button, Dialog, Empty, Muted, Notice, Table, Td, Tr } from '../ui/index.js';
import { APP_SCOPE_WORDS, shortDate as date } from './format.js';

/**
 * Apps people connected through sign-in, such as "Claude for Dana" (accounts
 * spec 5.1): in a workspace's Settings for its admins, and in Your account
 * for the person who connected them. Disconnecting ends the app's access at
 * its next request.
 */
export function ConnectedApps({
  workspaceId,
  showWorkspace = false,
}: {
  /** One workspace's apps; without it, the signed-in person's own everywhere. */
  workspaceId?: string;
  showWorkspace?: boolean;
}) {
  const client = useQueryClient();
  const key = ['account', 'connections', workspaceId ?? 'mine'];
  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      workspaceId
        ? (await accountApi.workspaceConnections(workspaceId)).connections
        : (await accountApi.connections()).connections,
  });
  const [ending, setEnding] = useState<Connection | null>(null),
    [error, setError] = useState('');
  const disconnect = useMutation({
    mutationFn: (id: string) => accountApi.disconnect(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['account', 'connections'] }),
    onError: (e: Error) => setError(e.message),
    onSettled: () => setEnding(null),
  });
  if (!list.data)
    return list.error ? (
      <QueryError error={list.error} retry={() => void list.refetch()} />
    ) : (
      <Notice>Loading connected apps…</Notice>
    );
  return (
    <>
      {error ? (
        <Notice error onDismiss={() => setError('')}>
          {error}
        </Notice>
      ) : null}
      {list.data.length === 0 ? (
        <Empty
          title="No connected apps"
          description="An app such as Claude appears here once someone connects it by signing in."
        />
      ) : (
        <Table
          headers={[
            { label: 'App' },
            ...(showWorkspace ? [{ label: 'Workspace' }] : []),
            { label: 'Can' },
            { label: 'Connected' },
            { label: '' },
          ]}
        >
          {list.data.map((c) => (
            <Tr key={c.id}>
              <Td first>
                {c.app.name} for {c.person.name || c.person.email}
              </Td>
              {showWorkspace ? <Td>{c.workspace.name}</Td> : null}
              <Td>
                {c.scopes
                  .map((s) => APP_SCOPE_WORDS[s])
                  .filter(Boolean)
                  .join('; ')}
              </Td>
              <Td>{date(c.connectedAt)}</Td>
              <Td>
                <Button size="small" variant="ghost" onClick={() => setEnding(c)}>
                  Disconnect
                </Button>
              </Td>
            </Tr>
          ))}
        </Table>
      )}
      <Muted small>
        An app can never do more than the person who connected it can do in that workspace.
      </Muted>
      <Dialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title={`Disconnect ${ending?.app.name ?? ''}?`}
        description="It loses access at its next request. To use it again, connect it again from the app."
      >
        <Button
          variant="destructive"
          disabled={disconnect.isPending}
          onClick={() => ending && disconnect.mutate(ending.id)}
        >
          Disconnect
        </Button>
      </Dialog>
    </>
  );
}
