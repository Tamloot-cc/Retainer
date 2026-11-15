import type { ObjectView } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { CheckLabel, Input, Muted, Notice, Row, SelectMenu, Stack } from '../../ui/index.js';

export function ExternalRecordImages() {
  const { session, schema } = useWorkspace();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!canMutate(session, 'admin')) return null;

  async function change(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await api.setExternalRecordImages(enabled);
      await client.invalidateQueries({ queryKey: [session.workspace.id, 'schema'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="small">
      <Row>
        <CheckLabel>
          <Input
            type="checkbox"
            role="switch"
            checked={schema.workspace.externalRecordImages === true}
            disabled={busy}
            onChange={(e) => void change(e.target.checked)}
          />
          Load external record images
        </CheckLabel>
        <Muted small>Send configured website domains to Twenty Icons to load favicons.</Muted>
      </Row>
      {error ? <Notice error>{error}</Notice> : null}
    </Stack>
  );
}

export function RecordImageField({ object }: { object: ObjectView }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields = object.fields.filter((field) => field.type === 'links');
  if (!fields.length) return null;

  async function change(value: string) {
    if (busy) return;
    const avatarField = value || null;
    if (avatarField === (object.avatarField ?? null)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.proposeSchemaChange([
        { op: 'update_object', object: object.nameSingular, avatarField },
      ]);
      if (result.status === 'failed') setError(result.change?.error ?? 'The change failed');
      else if (result.status === 'proposed') setError('Proposed: it applies once approved');
      await client.invalidateQueries({ queryKey: [session.workspace.id, 'schema'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="small">
      <Row>
        <span>Record image</span>
        {busy ? (
          <Muted>Saving…</Muted>
        ) : canMutate(session, 'schema:write') ? (
          <SelectMenu
            label="Record image"
            value={object.avatarField ?? ''}
            options={[
              { value: '', label: 'None' },
              ...fields.map((f) => ({ value: f.name, label: f.label })),
            ]}
            onChange={(value) => void change(value)}
          />
        ) : (
          <Muted>{fields.find((f) => f.name === object.avatarField)?.label ?? 'None'}</Muted>
        )}
      </Row>
      {error ? <Notice error>{error}</Notice> : null}
    </Stack>
  );
}
