import type {
  SourceTaskBatchInput,
  SourceTaskBatchResult,
  SourceTaskSchema,
} from '@retainer/extension';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { admitRun } from '../extension-runtime/admission.js';
import { requestHash } from '../idempotency.js';
import { retractEventClaims } from '../memory/events.js';
import { isEventIdentitySuppressed } from '../privacy/suppression.js';
import { prepareValues } from '../records/values.js';
import {
  insertRecord,
  lockRecordsForUpdate,
  softDeleteRecord,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { type SourcePolicy, taskIdentityChannel } from './policy.js';
import { detachEditedTasks } from './task-detach.js';

export { taskIdentityChannel } from './policy.js';
export function taskSchema(schema: CompiledSchema, policy: SourcePolicy) {
  const definition = policy.tasks;
  const object = definition && schema.objectsByUniversalId.get(definition.objectId);
  const errors: SourceTaskSchema['errors'] = [];
  const field = (role: string, id: string | undefined, type: string) => {
    const f = object?.activeFields.find((f) => f.universalId === id);
    if (!f || f.type !== type || f.settings.isInverse)
      errors.push({ field: role, reason: 'missing or incompatible field' });
    return f;
  };
  if (!definition || !object || object.hidden || object.isEvent || object.state.status !== 'active')
    errors.push({ field: 'task', reason: 'missing task object' });
  const identity = field('identity', definition?.identityFieldId, 'text'),
    title = field('title', definition?.titleFieldId, 'text'),
    status = field('status', definition?.statusFieldId, 'select');
  const person = definition?.personFieldId
    ? field('person', definition.personFieldId, 'relation')
    : undefined;
  if (identity && !identity.isUnique)
    errors.push({ field: 'identity', reason: 'identity must remain unique' });
  if (
    status &&
    definition &&
    !Object.values(definition.statuses).every((value) =>
      status.settings.options?.some((o) => o.value === value),
    )
  )
    errors.push({ field: 'status', reason: 'missing status option' });
  const personObject =
    person && schema.objectsByUniversalId.get(person.settings.targetObjectId ?? '');
  if (
    person &&
    (person.settings.relationCardinality !== 'many_to_one' ||
      !personObject ||
      personObject.hidden ||
      personObject.isEvent ||
      personObject.state.status !== 'active')
  )
    errors.push({ field: 'person', reason: 'incompatible relation target' });
  const response: SourceTaskSchema = {
    status: errors.length ? 'degraded' : 'ok',
    fields: Object.fromEntries(
      Object.entries({ identity, title, status, person }).flatMap(([role, f]) =>
        f ? [[role, { name: f.name, type: f.type }]] : [],
      ),
    ),
    errors,
  };
  return { response, object, identity, title, status, person, personObject, definition };
}
type Binding = {
  id: string;
  external_id: string;
  record_id: string;
  state: string;
  content_digest: string | null;
  item_id: string;
};
/** One bounded prefix. The caller holds identity, source item and event locks before task locks. */
export async function reconcileTasks(
  tx: Tx,
  context: WriteContext,
  policy: SourcePolicy,
  account: { account_id: string; registration_id: string; provider: string; namespace: string },
  itemId: string,
  eventId: string | null,
  input: SourceTaskBatchInput,
): Promise<SourceTaskBatchResult> {
  const resolved = taskSchema(context.schema, policy);
  const result: SourceTaskBatchResult = {
    applied: 0,
    removed: 0,
    detached: 0,
    unchanged: 0,
    erased: 0,
    hasMore: false,
    checkpoint: 0,
    bindingStatus: resolved.response.status,
    warnings: [],
  };
  const { object, identity, title, status, person, personObject, definition } = resolved;
  if (
    resolved.response.status !== 'ok' ||
    !object ||
    !identity ||
    !title ||
    !status ||
    !definition
  ) {
    result.warnings.push('source_task_schema_degraded');
    return result;
  }
  const complete = input.complete && input.tasks.length < 500;
  if (!complete) result.warnings.push('source_tasks_incomplete');
  const externalIds = input.tasks.map((t) => t.externalId).sort();
  const rows = await tx<
    Binding[]
  >`select * from source_tasks where account_id=${account.account_id} and (external_id=any(${externalIds}::text[]) or item_id=${itemId}) order by record_id`;
  const locked = await lockRecordsForUpdate(
    tx,
    context.workspaceId,
    rows.map((r) => r.record_id),
  );
  const refreshed = await tx<
    Binding[]
  >`select * from source_tasks where id=any(${rows.map((r) => r.id)}::uuid[])`;
  const bindings = new Map(refreshed.map((r) => [r.external_id, r]));
  const records = new Map(locked.map((r) => [r.id, r]));
  let changed = 0;
  const budget = async () => {
    if (changed >= 30) {
      result.hasMore = true;
      return false;
    }
    if (changed && context.run) {
      try {
        await admitRun(tx, context.workspaceId, context.run, true);
      } catch (error) {
        if (error instanceof AppError && error.code === 'quota_exceeded') {
          result.hasMore = true;
          return false;
        }
        throw error;
      }
    }
    changed++;
    return true;
  };
  const edited = await tx<
    { record_id: string }[]
  >`select distinct record_id from field_assertions where record_id=any(${locked.map((r) => r.id)}::uuid[]) and actor->>'type'='user'`;
  const editedIds = new Set(edited.map((r) => r.record_id));
  const detach = async (binding: Binding) => {
    if (binding.state !== 'synced' || !editedIds.has(binding.record_id)) return false;
    if (!(await budget())) return true;
    result.detached += await detachEditedTasks(
      tx,
      context,
      locked.filter((r) => r.id === binding.record_id),
    );
    binding.state = 'detached';
    return true;
  };
  const [event] = eventId
    ? await tx<
        { occurred_at: Date }[]
      >`select occurred_at from event_records where record_id=${eventId}`
    : [];
  for (const task of input.tasks) {
    const binding = bindings.get(task.externalId);
    if (binding && (await detach(binding))) {
      if (result.hasMore) break;
      continue;
    }
    if (binding && ['detached', 'local_deleted'].includes(binding.state)) {
      result.unchanged++;
      continue;
    }
    if (
      await isEventIdentitySuppressed(
        tx,
        context.workspaceId,
        taskIdentityChannel(account.registration_id, account.provider, account.namespace),
        task.externalId,
      )
    ) {
      result.erased++;
      continue;
    }
    if (!eventId || !event)
      throw new AppError(409, 'source_revision_conflict', 'task evidence is no longer current');
    let record = binding && records.get(binding.record_id);
    if (record?.merged_into_id || (record?.deleted_at && binding?.state !== 'removed')) {
      await tx`update source_tasks set state='local_deleted',content_digest=null where id=${binding!.id}`;
      result.unchanged++;
      continue;
    }
    let personId: string | null = null;
    if (personObject && task.contactEmails.length) {
      const matches = await tx<
        { record_id: string }[]
      >`select distinct i.record_id from record_identifiers i join records r on r.id=i.record_id where i.workspace_id=${context.workspaceId} and i.kind='email' and i.is_claim and i.value=any(${task.contactEmails}::text[]) and r.object_type_id=${personObject.id} and r.deleted_at is null and r.merged_into_id is null limit 2`;
      if (matches.length === 1) personId = matches[0]!.record_id;
    }
    const digest = requestHash({ eventId, title: task.title, status: task.status, personId });
    if (
      binding?.state === 'synced' &&
      binding.item_id === itemId &&
      binding.content_digest === digest
    ) {
      result.unchanged++;
      continue;
    }
    if (!(await budget())) break;
    const identityValue = JSON.stringify([account.account_id, task.externalId]);
    const values = prepareValues(
      object,
      {
        [identity.name]: identityValue,
        [title.name]: task.title,
        [status.name]: definition.statuses[task.status],
        ...(person ? { [person.name]: personId } : {}),
      },
      record ? 'update' : 'create',
    );
    values.delete(identity);
    if (!record) {
      const collision =
        await tx`select 1 from record_identifiers where workspace_id=${context.workspaceId} and field_id=${identity.id!} and value=${identityValue} and is_claim`;
      if (collision.length)
        throw new AppError(
          409,
          'source_task_conflict',
          'the managed task identity is already held by another record',
          { field: identity.name },
        );
      record = await insertRecord(tx, context, object);
      await writeFields(tx, context, object, record, new Map([[identity, identityValue]]));
    } else if (record.deleted_at) {
      await context.changes?.capture(tx, record.id);
      await tx`update records set deleted_at=null,updated_at=clock_timestamp(),updated_by=${tx.json(context.actor)} where id=${record.id}`;
      record = { ...record, deleted_at: null };
    }
    await writeFields(tx, context, object, record, values, {
      sourceRecordId: eventId,
      observedAt: event.occurred_at,
    });
    if (binding && binding.item_id !== itemId)
      await tx`update source_items set task_write_revision=task_write_revision+1 where id=${binding.item_id}`;
    await tx`insert into source_tasks(workspace_id,installation_id,account_id,external_id,item_id,record_id,source_event_id,content_digest,actor_name)
      values(${context.workspaceId},${context.run!.installationId},${account.account_id},${task.externalId},${itemId},${record.id},${eventId},${digest},${context.actor.name ?? null})
      on conflict(workspace_id,account_id,external_id) do update set installation_id=excluded.installation_id,item_id=excluded.item_id,source_event_id=excluded.source_event_id,state='synced',content_digest=excluded.content_digest,actor_name=excluded.actor_name`;
    result.applied++;
  }
  if (complete && !result.hasMore)
    for (const binding of refreshed) {
      if (
        binding.item_id !== itemId ||
        externalIds.includes(binding.external_id) ||
        binding.state !== 'synced'
      )
        continue;
      if (await detach(binding)) {
        if (result.hasMore) break;
        continue;
      }
      const record = records.get(binding.record_id);
      if (!record || record.deleted_at || record.merged_into_id) {
        await tx`update source_tasks set state='local_deleted',content_digest=null where id=${binding.id}`;
        continue;
      }
      if (!(await budget())) break;
      const deleted = await softDeleteRecord(
        tx,
        { ...context, managedTaskRemovalIds: [record.id] },
        record.id,
      );
      for (const id of deleted) {
        const cached = records.get(id);
        if (cached) records.set(id, { ...cached, deleted_at: new Date() });
      }
      const events = await tx<
        { record_id: string }[]
      >`select record_id from event_records where record_id=any(${deleted}::uuid[])`;
      if (events.length)
        await retractEventClaims(
          tx,
          context,
          events.map((e) => e.record_id),
        );
      await tx`update source_tasks set state='removed',content_digest=null where id=${binding.id}`;
      result.removed++;
    }
  const [checkpoint] = changed
    ? await tx<
        { task_write_revision: number }[]
      >`update source_items set task_write_revision=task_write_revision+1 where id=${itemId} returning task_write_revision`
    : await tx<
        { task_write_revision: number }[]
      >`select task_write_revision from source_items where id=${itemId}`;
  result.checkpoint = checkpoint?.task_write_revision ?? 0;
  return result;
}
