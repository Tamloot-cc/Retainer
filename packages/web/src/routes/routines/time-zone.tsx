import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Button,
  Dialog,
  FormField,
  Muted,
  Notice,
  Row,
  SelectMenu,
  Stack,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
import { errorText, routinesKey, useTimeZone } from './model.js';

/** Every IANA zone this browser knows, UTC first. */
function zones() {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = [];
  }
  return ['UTC', ...all.filter((zone) => zone !== 'UTC')].map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
    keywords: zone,
  }));
}

/**
 * The workspace time zone (routines spec §7): schedules such as "every
 * weekday at 9:00" are read in it. Admins change it; others see it.
 */
export function TimeZoneSetting({ onSaved }: { onSaved?: () => void }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const current = useTimeZone();
  const admin = canMutate(session, 'admin');
  const [chosen, setChosen] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (zone: string) => api.setTimeZone(zone),
    onSuccess: async () => {
      setSaved(true);
      setChosen(null);
      await client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
      onSaved?.();
    },
  });
  if (current.error)
    return <QueryError error={current.error} retry={() => void current.refetch()} />;
  if (!current.data) return <Muted>Loading the time zone…</Muted>;
  const value = chosen ?? current.data;
  return (
    <Stack>
      <Muted>
        Scheduled routines, such as one that runs every weekday at 9:00, follow this time zone.
      </Muted>
      {admin ? (
        <>
          <FormField label="Time zone">
            <SelectMenu
              label="Time zone"
              options={zones()}
              value={value}
              onChange={(zone) => {
                setChosen(zone);
                setSaved(false);
              }}
            />
          </FormField>
          {save.error ? (
            <Notice error>{errorText(save.error, 'change the time zone')}</Notice>
          ) : null}
          {saved ? <Notice onDismiss={() => setSaved(false)}>Time zone saved.</Notice> : null}
          <Row>
            <Button
              variant="primary"
              disabled={save.isPending || value === current.data}
              onClick={() => save.mutate(value)}
            >
              {save.isPending ? 'Saving…' : 'Save time zone'}
            </Button>
          </Row>
        </>
      ) : (
        <p className="text-sm">{current.data}. Only a workspace admin can change it.</p>
      )}
    </Stack>
  );
}

/** One line naming the time zone, with a way for admins to change it. */
export function TimeZoneLine() {
  const { session } = useWorkspace();
  const current = useTimeZone();
  const [open, setOpen] = useState(false);
  if (!current.data) return null;
  return (
    <Row>
      <Muted>Schedules follow the workspace time zone, {current.data}.</Muted>
      {canMutate(session, 'admin') ? (
        <Button size="small" variant="ghost" onClick={() => setOpen(true)}>
          Change time zone
        </Button>
      ) : null}
      {open ? (
        <Dialog open onOpenChange={setOpen} title="Workspace time zone">
          <TimeZoneSetting onSaved={() => setOpen(false)} />
        </Dialog>
      ) : null}
    </Row>
  );
}
