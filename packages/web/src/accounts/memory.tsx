import type { ProfileAlias } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { FactsPanel, type FactsWords } from '../routes/records/record-memory.js';
import { Button, Dialog, Muted, Notice, Panel, Stack } from '../ui/index.js';

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
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
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
          <FactsPanel
            recordId="workspace"
            canRetract={canMutate(session)}
            words={words('workspace')}
          />
        </Stack>
      </Panel>
      {session.person ? (
        <Panel title="About you">
          <Stack>
            <Muted small>
              What your agents learned about you, such as how you like to work. Only you and the
              agents that work for you see it. It is deleted if you leave this workspace.
            </Muted>
            <FactsPanel recordId="me" canRetract words={words('me')} />
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

const words = (profile: ProfileAlias): FactsWords => ({
  list: profile === 'me' ? 'About you' : 'About this workspace',
  empty: {
    title: 'Nothing yet',
    description:
      profile === 'me'
        ? 'Agents that work for you add what they learn about you here.'
        : 'Agents add what they learn about this team here.',
  },
  retract: 'Remove',
  confirm: { title: 'Remove this?', description: 'Agents stop seeing it at once.' },
  done: 'Removed.',
});
