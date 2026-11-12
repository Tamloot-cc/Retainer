import { RetainerApiError } from '@retainer/sdk';
import type { ObjectView } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { fields } from '../../fields/index.js';
import { Button, Dialog, Form, FormField, Notice, RecordLink, Row } from '../../ui/index.js';
import { useApiName } from '../developer.js';
import {
  creatableFields,
  initialDraft,
  prepareCreateValues,
  serverFieldErrors,
} from './write-model.js';

/**
 * A form built from the object's fields. The idempotency key lives as long
 * as the dialog, so a retry after a lost response cannot create a second
 * record; a new dialog is a new key.
 */
export function CreateRecordDialog({
  object,
  onClose,
  onCreated,
}: {
  object: ObjectView;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { session } = useWorkspace(),
    client = useQueryClient(),
    apiName = useApiName();
  const list = useMemo(() => creatableFields(object), [object]);
  const [draft, setDraft] = useState(() => initialDraft(list)),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(''),
    [saving, setBusy] = useState(false),
    [uploads, setUploads] = useState<Record<string, boolean>>({}),
    [key] = useState(() => crypto.randomUUID());
  const busy = saving || Object.values(uploads).some(Boolean);
  async function create() {
    if (busy) return;
    const { values, errors } = prepareCreateValues(list, draft);
    setErrors(errors);
    setError('');
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const result = await api.createRecord(object.nameSingular, { values }, key);
      onCreated(result.id);
      void client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      const failure = e instanceof RetainerApiError ? e : null;
      const fieldErrors = serverFieldErrors(failure?.details);
      const holder = (failure?.details as { recordId?: unknown } | undefined)?.recordId;
      setErrors(fieldErrors);
      setConflict(failure?.code === 'unique_conflict' && typeof holder === 'string' ? holder : '');
      // A failed request rolls its key back, so the same key is safe to retry.
      // It is only taken when an earlier attempt succeeded unseen and the
      // form changed since.
      setError(
        failure?.code === 'idempotency_key_reused'
          ? 'A record may already have been created from this form. Check the list before creating another.'
          : Object.keys(fieldErrors).length
            ? 'Some values need a change.'
            : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`New ${object.labelSingular.toLowerCase()}`}
      description="Values you enter are recorded as yours. Leave a field empty to skip it."
    >
      <Form onSubmit={() => void create()}>
        {error ? (
          <Notice error>
            <Row>
              {error}
              {conflict ? <RecordLink id={conflict}>View that record</RecordLink> : null}
            </Row>
          </Notice>
        ) : null}
        {list.map((f) => {
          const Input = fields[f.type].Input;
          return (
            <FormField
              key={f.name}
              label={f.label}
              apiName={apiName(f.name)}
              hint={f.isNullable ? undefined : 'Required'}
              error={errors[f.name] ? `${f.label} ${errors[f.name]}` : undefined}
            >
              <Input
                field={f}
                onBusyChange={(busy) => setUploads((previous) => ({ ...previous, [f.name]: busy }))}
                value={draft[f.name] ?? null}
                onChange={(value) => setDraft((d) => ({ ...d, [f.name]: value }))}
              />
            </FormField>
          );
        })}
        <Row>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : `Create ${object.labelSingular.toLowerCase()}`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Form>
    </Dialog>
  );
}
