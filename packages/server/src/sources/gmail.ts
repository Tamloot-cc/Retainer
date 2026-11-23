import { randomUUID } from 'node:crypto';
import { EVENT_CONTENT_MAX, isoDateTimeSchema } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { requireBindingCreation, type StoredBindingPlan } from '../extension-runtime/bindings.js';
import { requestHash } from '../idempotency.js';
import { joinEventThreads, storeEventBody } from '../memory/event-bodies.js';
import { addEventLinks, logEvent } from '../memory/events.js';
import { isEventIdentitySuppressed, isSuppressed, suppressedOf } from '../privacy/suppression.js';
import { normalizeEmail } from '../records/derive.js';
import type { WriteContext } from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';

const channel = 'gmail';
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const emails = z.array(z.email().max(320)).max(200);
export const gmailAddressesSchema = z.strictObject({ from: emails, to: emails });
export const gmailMessageSchema = gmailAddressesSchema
  .extend({
    messageId: providerId,
    threadId: providerId,
    rfcMessageId: z.string().max(500).optional(),
    occurredAt: isoDateTimeSchema,
    originalDate: isoDateTimeSchema.optional(),
    subject: z.string().max(500),
    body: z.string().min(1).max(EVENT_CONTENT_MAX),
    targetEmail: z.email().max(320).optional(),
    targetPersonId: z.uuid().optional(),
  })
  .refine((input) => !!input.targetEmail === !!input.targetPersonId);
type Input = z.infer<typeof gmailMessageSchema>;
type Binding = { connectionId: string; installationId: string; plan: StoredBindingPlan | null };

function addressSet(addresses: readonly string[]) {
  return [...new Set(addresses.map(normalizeEmail))].sort();
}

export function gmailConversationSchema(schema: CompiledSchema, plan: StoredBindingPlan | null) {
  const bound = plan?.destinations.email;
  const object = schema.objectsByUniversalId.get(bound?.objects[0] ?? '');
  const mediumChoice = bound?.fields.medium;
  const medium = object?.activeFields.find((field) => field.universalId === mediumChoice?.id);
  const value = mediumChoice?.values.email;
  if (
    !object?.isEvent ||
    object.hidden ||
    medium?.type !== 'select' ||
    !value ||
    !medium.settings.options?.some((option) => option.value === value)
  )
    throw new AppError(
      409,
      'binding_unavailable',
      'The approved Gmail event binding is unavailable.',
    );
  return { object, medium, value };
}

/** The pre-fetch check is repeated under the exclusive schema lock at import. */
export async function matchGmailPeople(
  tx: Tx,
  context: Pick<WriteContext, 'workspaceId' | 'schema'>,
  addresses: { from: string[]; to: string[] },
  plan: StoredBindingPlan | null,
  mailbox?: { connectionId: string; occurredAt: string },
) {
  const people = plan?.destinations.person;
  if (!people) return [];
  const person = context.schema.objectsByUniversalId.get(people.objects[0] ?? '');
  const email = person?.activeFields.find(
    (field) => field.universalId === people.fields.emails?.id,
  );
  if (
    !person ||
    person.hidden ||
    person.state.status !== 'active' ||
    email?.type !== 'emails' ||
    !email.id
  )
    throw new AppError(
      409,
      'binding_unavailable',
      'The approved Gmail email matching field is unavailable.',
    );
  const values = addressSet([...addresses.from, ...addresses.to]);
  if (!values.length) return [];
  const handles = values.map((value) => ({ kind: 'email' as const, value }));
  const suppressed = await suppressedOf(tx, context.workspaceId, handles);
  // Ambiguity is evaluated across distinct live People, including non-unique email fields.
  // A suppressed envelope never contributes body text.
  if (handles.some((handle) => isSuppressed(suppressed, handle))) return [];
  const rows = await tx<{ email: string; record_id: string }[]>`
    select i.value as email, min(r.id::text)::uuid as record_id
    from record_identifiers i join records r on r.id=i.record_id and r.workspace_id=i.workspace_id
    join fields f on f.id=i.field_id and f.workspace_id=i.workspace_id
    where i.workspace_id=${context.workspaceId} and i.kind='email' and i.value=any(${values}::text[])
      and r.object_type_id=${person.id} and i.field_id=${email.id} and r.deleted_at is null and r.merged_into_id is null
      and r.private_to_user is null and f.status='active'
    group by i.value having count(distinct r.id)=1
      and (${!mailbox} or not exists(
        select 1 from (
          select a.history_days,a.created_at from gmail_contact_additions a
          join extension_connections c on c.id=${mailbox?.connectionId ?? null} and c.workspace_id=a.workspace_id
          where a.workspace_id=${context.workspaceId} and a.record_id=min(r.id::text)::uuid
            and a.email=i.value and a.created_at>=c.created_at
          order by a.created_at desc,a.id desc limit 1
        ) latest
        where latest.created_at - latest.history_days * interval '24 hours'
          > ${mailbox?.occurredAt ?? null}::timestamptz
      ))
    order by i.value`;
  return rows.map(({ email, record_id }) => ({ handle: email, recordId: record_id }));
}

function gmailIdentity(input: Input, binding: Binding) {
  if (input.rfcMessageId && /^<[^\s<>@]+@[^\s<>@]+>$/.test(input.rfcMessageId))
    return requestHash({
      messageId: input.rfcMessageId,
      from: addressSet(input.from),
      to: addressSet(input.to),
      subject: input.subject,
      body: input.body,
    });
  return requestHash({ mailbox: binding.connectionId, messageId: input.messageId });
}

/** Append an immutable message. Caller holds write admission and the exclusive schema lock. */
export async function appendGmailMessage(
  tx: Tx,
  context: WriteContext,
  binding: Binding,
  input: Input,
) {
  const { workspaceId } = context;
  const { object, medium, value } = gmailConversationSchema(context.schema, binding.plan);
  const participants = await matchGmailPeople(tx, context, input, binding.plan, {
    connectionId: binding.connectionId,
    occurredAt: input.occurredAt,
  });
  if (
    !participants.length ||
    (input.targetEmail &&
      !participants.some(
        (p) =>
          p.handle === normalizeEmail(input.targetEmail ?? '') &&
          p.recordId === input.targetPersonId,
      ))
  )
    return { kind: 'no_match' as const };

  const identity = gmailIdentity(input, binding);
  if (await isEventIdentitySuppressed(tx, workspaceId, channel, identity))
    return { kind: 'removed' as const };

  const [prior] = await tx<{ id: string; object_type_id: string; deleted_at: Date | null }[]>`
    select d.message_id as id, r.object_type_id, r.deleted_at from gmail_deliveries d
    join records r on r.id = d.message_id and r.workspace_id = d.workspace_id
    where d.workspace_id=${workspaceId} and d.connection_id=${binding.connectionId}
      and d.provider_message_id=${input.messageId}`;
  const [duplicate] = await tx<{ id: string; object_type_id: string; deleted_at: Date | null }[]>`
    select r.id,r.object_type_id,r.deleted_at from event_records e
      join records r on r.id=e.record_id and r.workspace_id=e.workspace_id
      join event_bodies m on m.event_id=r.id and m.workspace_id=r.workspace_id
    where e.workspace_id=${workspaceId} and e.channel=${channel} and e.external_id=${identity}`;
  const existing = prior ?? duplicate;
  if (existing?.deleted_at) return { kind: 'removed' as const };
  if (existing && existing.object_type_id !== object.id) {
    if (!prior)
      await tx`insert into gmail_deliveries(workspace_id,installation_id,connection_id,message_id,provider_message_id,provider_thread_id)
        values(${workspaceId},${binding.installationId},${binding.connectionId},${existing.id},${input.messageId},${input.threadId})`;
    return {
      kind: 'imported' as const,
      messageId: existing.id,
      eventId: existing.id,
      created: false,
    };
  }
  const groups = await tx<{ id: string; deleted: boolean }[]>`
    select thread_id as id, bool_or(r.deleted_at is not null) as deleted
    from event_bodies m join records r on r.id=m.event_id and r.workspace_id=m.workspace_id
    where m.workspace_id=${workspaceId} and m.thread_id in (
      select candidate.thread_id from event_bodies candidate
      join records destination on destination.id = candidate.event_id
        and destination.workspace_id = candidate.workspace_id and destination.object_type_id = ${object.id}
      where candidate.workspace_id=${workspaceId} and (
        candidate.event_id=${prior?.id ?? duplicate?.id ?? null} or candidate.event_id in (
          select d.message_id from gmail_deliveries d
          where d.workspace_id=${workspaceId} and d.connection_id=${binding.connectionId}
            and d.provider_thread_id=${input.threadId}
        )
      )
    )
    group by m.thread_id order by m.thread_id`;
  if (duplicate?.deleted_at || groups.some((group) => group.deleted))
    return { kind: 'removed' as const };

  const threadGroupId = groups[0]?.id ?? randomUUID();
  const existingId = prior?.id ?? duplicate?.id;
  let messageId: string;
  if (existingId) {
    messageId = existingId;
    await addEventLinks(
      tx,
      context,
      messageId,
      { participants, about: [] },
      { resolveHandles: false },
    );
  } else {
    requireBindingCreation(binding.plan, 'email');
    const event = await logEvent(
      tx,
      context,
      {
        type: object.name,
        channel,
        externalId: identity,
        occurredAt: input.occurredAt,
        title: input.subject || '(No subject)',
        fields: { [medium.name]: value },
        participants,
        about: [],
      },
      { resolveHandles: false },
    );
    if (!event.created)
      throw new AppError(409, 'gmail_identity_conflict', 'Gmail evidence identity already in use');
    messageId = event.id;
    await storeEventBody(tx, workspaceId, {
      eventId: messageId,
      threadId: threadGroupId,
      occurredAt: new Date(input.occurredAt),
      originalDate: input.originalDate ? new Date(input.originalDate) : undefined,
      body: input.body,
    });
  }
  if (!prior)
    await tx`insert into gmail_deliveries(workspace_id,installation_id,connection_id,message_id,provider_message_id,provider_thread_id)
      values(${workspaceId},${binding.installationId},${binding.connectionId},${messageId},${input.messageId},${input.threadId})`;
  await joinEventThreads(
    tx,
    workspaceId,
    threadGroupId,
    groups.slice(1).map((group) => group.id),
  );
  const [representative] = await tx<{ id: string }[]>`
    select event_id as id from event_bodies where workspace_id=${workspaceId} and thread_id=${threadGroupId}
    order by occurred_at desc,event_id desc limit 1`;
  if (!representative) throw new Error('Gmail conversation has no evidence');
  const people = await tx<{ record_id: string }[]>`
    select distinct l.record_id from event_bodies m
    join event_links l on l.workspace_id=m.workspace_id and l.event_id=m.event_id
    join records r on r.id=l.record_id and r.workspace_id=l.workspace_id
    where m.workspace_id=${workspaceId} and m.thread_id=${threadGroupId}
      and l.link='participant' and r.deleted_at is null and r.merged_into_id is null
      and not exists(select 1 from event_links p where p.event_id=${representative.id} and p.record_id=l.record_id)`;
  // Keep the thread visible on every participant timeline, even when the
  // newest message was addressed to only some of them.
  if (people.length)
    await addEventLinks(tx, context, representative.id, {
      participants: people.map(({ record_id }) => ({ recordId: record_id })),
      about: [],
    });
  return { kind: 'imported' as const, messageId, eventId: representative.id, created: !existingId };
}
