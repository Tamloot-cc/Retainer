import type { ProfileAlias } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { FactSources } from '../provenance/index.js';
import { FactRow } from '../routes/records/record-memory.js';
import { byCursor, QueryError } from '../routes/state.js';
import { EntryList, EntryLoading, LoadMore } from '../ui/entry.js';
import { Button, Dialog, Empty, Muted, Notice, Panel, Stack } from '../ui/index.js';

/**
 * Settings → Memory (personal memory spec 4.8): what agents remember about
 * the workspace and about the signed-in person. People review and remove
 * facts here; agents write them.
 */
export function MemoryTab() {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const [clearing, setClearing] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function clearAll() {
    setBusy(true);
    try {
      await api.clearMyMemory();
      setMessage('Your memory in this workspace is cleared.');
      await client.invalidateQueries({ queryKey: [session.workspace.id, 'facts', 'me'] });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      setClearing(false);
    }
  }
  return (
    <Stack>
      {message ? <Notice onDismiss={() => setMessage('')}>{message}</Notice> : null}
      <Panel title="About this workspace">
        <Stack>
          <Muted small>
            What agents learned about how this team works: how you sell, who decides what, the words
            you use. Everyone here and their agents see it.
          </Muted>
          <ProfileFacts profile="workspace" canRemove={canMutate(session)} onError={setMessage} />
        </Stack>
      </Panel>
      {session.person ? (
        <Panel title="About you">
          <Stack>
            <Muted small>
              What your agents learned about you, such as how you like to work. Only you and the
              agents that work for you see it. It is deleted if you leave this workspace.
            </Muted>
            <ProfileFacts profile="me" canRemove onError={setMessage} />
            <div>
              <Button variant="destructive" onClick={() => setClearing(true)}>
                Clear all
              </Button>
            </div>
          </Stack>
        </Panel>
      ) : null}
      <Dialog
        open={clearing}
        onOpenChange={(open) => {
          if (!open && !busy) setClearing(false);
        }}
        title="Clear everything agents remember about you here?"
        description="Your facts and their notes are deleted for good. Your agents start again from nothing in this workspace."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void clearAll()}>
          Clear all
        </Button>
      </Dialog>
    </Stack>
  );
}

function ProfileFacts({
  profile,
  canRemove,
  onError,
}: {
  profile: ProfileAlias;
  canRemove: boolean;
  onError: (message: string) => void;
}) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const facts = useInfiniteQuery({
    queryKey: [session.workspace.id, 'facts', profile],
    queryFn: ({ signal, pageParam }) => api.facts(profile, { cursor: pageParam, signal }),
    ...byCursor,
  });
  const [removing, setRemoving] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const items = facts.data?.pages.flatMap((p) => p.facts) ?? [];
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.retractFact(removing);
      await client.invalidateQueries({ queryKey: [session.workspace.id, 'facts', profile] });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }
  return (
    <>
      {facts.error ? <QueryError error={facts.error} retry={() => void facts.refetch()} /> : null}
      {facts.isPending ? <EntryLoading label="Loading…" /> : null}
      {facts.data && !items.length ? (
        <Empty
          quiet
          title="Nothing yet"
          description={
            profile === 'me'
              ? 'Agents that work for you add what they learn about you here.'
              : 'Agents add what they learn about this team here.'
          }
        />
      ) : null}
      {items.length ? (
        <EntryList label={profile === 'me' ? 'About you' : 'About this workspace'}>
          {items.map((f) => (
            <FactRow
              key={f.id}
              fact={f}
              retractLabel="Remove"
              {...(canRemove ? { onRetract: () => setRemoving(f.id) } : {})}
            >
              <FactSources sources={f.sources} />
            </FactRow>
          ))}
        </EntryList>
      ) : null}
      {facts.hasNextPage ? (
        <LoadMore loading={facts.isFetchingNextPage} onClick={() => void facts.fetchNextPage()} />
      ) : null}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
        title="Remove this?"
        description="Agents stop seeing it at once."
      >
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
      </Dialog>
    </>
  );
}
