import { useNavigate, useParams } from '@tanstack/react-router';
import { useWorkspace } from '../../api/client.js';
import { Notice, ObjectIcon, Page, RecordAvatar } from '../../ui/index.js';
import { ExtensionRecordButtons } from '../extensions/record-buttons.js';
import { RoutineButtons } from '../routines/record-buttons.js';
import { classLabel, objectByName, QueryError, recordTitle } from '../state.js';
import { RecordActions } from './record-actions.js';
import { useMemoryNav } from './record-memory.js';
import { RecordView, useRecord } from './record-view.js';

export function RecordPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { schema } = useWorkspace();
  const nav = useMemoryNav();
  const navigate = useNavigate();
  const record = useRecord(id);
  if (!record.data)
    return (
      <Page title="Record">
        {record.error ? (
          <QueryError error={record.error} retry={() => void record.refetch()} />
        ) : (
          <Notice>Loading record…</Notice>
        )}
      </Page>
    );
  const r = record.data;
  const object = objectByName(schema, r.object);
  return (
    <Page
      eyebrow={classLabel(objectByName(schema, r.object)) ?? r.object}
      eyebrowLink={{ to: '/o/$object', params: { object: r.object } }}
      title={recordTitle(r)}
      icon={<ObjectIcon name={r.object} objectClass={object?.class} />}
      avatar={
        <RecordAvatar
          id={r.id}
          name={recordTitle(r)}
          object={r.object}
          objectClass={object?.class}
          large
        />
      }
      description={`Last updated ${new Date(r.updatedAt).toLocaleString()}`}
      actions={
        <>
          <ExtensionRecordButtons object={r.object} recordId={r.id} />
          <RoutineButtons object={r.object} recordId={r.id} />
          <RecordActions
            record={r}
            requestedId={id}
            onGone={() => void navigate({ to: '/o/$object', params: { object: r.object } })}
          />
        </>
      }
    >
      <RecordView key={r.id} record={r} requestedId={id} nav={nav} />
    </Page>
  );
}
