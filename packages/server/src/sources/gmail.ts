import { randomUUID } from 'node:crypto';
import {
  BASE_EVENT_FIELD_IDS,
  BASE_EVENT_TYPE_IDS,
  BASE_OBJECT_IDS,
  isoDateTimeSchema,
} from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
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
    body: z.string().min(1).max(256_000),
    targetEmail: z.email().max(320).optional(),
    targetPersonId: z.uuid().optional(),
  })
  .refine((input) => !!input.targetEmail === !!input.targetPersonId);
type Input = z.infer<typeof gmailMessageSchema>;
type Binding = { connectionId: string; installationId: string };

function addressSet(addresses: readonly string[]) {
  return [...new Set(addresses.map(normalizeEmail))].sort();
}

export function gmailConversationSchema(schema: CompiledSchema) {
  const object = schema.objectsByUniversalId.get(BASE_EVENT_TYPE_IDS.conversation);
  const medium = object?.activeFields.find(
    (field) => field.universalId === BASE_EVENT_FIELD_IDS.conversationMedium,
  );
  if (
    !object?.isEvent ||
    object.hidden ||
    medium?.type !== 'select' ||
    !medium.settings.options?.some((option) => option.value === 'email')
  )
    throw new AppError(
      409,
      'gmail_schema_unavailable',
      'Gmail requires Conversation with an email medium',
    );
  return { object, medium };
}

/** The pre-fetch check is repeated under the exclusive schema lock at import. */
export async function matchGmailPeople(
  tx: Tx,
  context: Pick<WriteContext, 'workspaceId' | 'schema'>,
  addresses: { from: string[]; to: string[] },
  mailbox?: { connectionId: string; occurredAt: string },
) {
  const person = context.schema.objectsByUniversalId.get(BASE_OBJECT_IDS.person);
  if (!person || person.hidden || person.state.status !== 'active') return [];
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
      and r.object_type_id=${person.id} and r.deleted_at is null and r.merged_into_id is null
      and r.private_to_user is null and f.status='active'
    group by i.value having count(distinct r.id)=1
      and (${!mailbox} or not exists(
        select 1 from (
          select a.history_days,a.created_at from gmail_contact_additions a
          join extension_connections c on c.id=${mailbox?.connectionId ?? null} and c.workspace_id=a.workspace_id
          where a.workspace_id=${context.workspaceId} and a.record_id=min(r.id::text)::uuid
            and a.email=i.value and a.created_at>=c.created_at
          order by a.created_at desc,a.id desc limit 1
        ) latest where latest.history_days=0 and latest.created_at>${mailbox?.occurredAt ?? null}::timestamptz
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
  const { object, medium } = gmailConversationSchema(context.schema);
  const participants = await matchGmailPeople(tx, context, input, {
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

  const [prior] = await tx<{ id: string }[]>`
    select message_id as id from gmail_deliveries
    where workspace_id=${workspaceId} and connection_id=${binding.connectionId}
      and provider_message_id=${input.messageId}`;
  const [duplicate] = await tx<{ id: string; deleted_at: Date | null }[]>`
    select r.id,r.deleted_at from event_records e
      join records r on r.id=e.record_id and r.workspace_id=e.workspace_id
      join gmail_messages m on m.event_id=r.id and m.workspace_id=r.workspace_id
    where e.workspace_id=${workspaceId} and e.channel=${channel} and e.external_id=${identity}`;
  const groups = await tx<{ id: string; deleted: boolean }[]>`
    select thread_group_id as id, bool_or(r.deleted_at is not null) as deleted
    from gmail_messages m join records r on r.id=m.event_id and r.workspace_id=m.workspace_id
    where m.workspace_id=${workspaceId} and m.thread_group_id in (
      select candidate.thread_group_id from gmail_messages candidate
      where candidate.workspace_id=${workspaceId} and (
        candidate.event_id=${prior?.id ?? duplicate?.id ?? null} or candidate.event_id in (
          select d.message_id from gmail_deliveries d
          where d.workspace_id=${workspaceId} and d.connection_id=${binding.connectionId}
            and d.provider_thread_id=${input.threadId}
        )
      )
    )
    group by m.thread_group_id order by m.thread_group_id`;
  if (duplicate?.deleted_at || groups.some((group) => group.deleted))
    return { kind: 'removed' as const };

  const threadGroupId = groups[0]?.id ?? randomUUID();
  const existingId = prior?.id ?? duplicate?.id;
  let messageId: string;
  if (existingId) {
    messageId = existingId;
    await addEventLinks(tx, context, messageId, { participants, about: [] });
  } else {
    const event = await logEvent(tx, context, {
      type: object.name,
      channel,
      externalId: identity,
      occurredAt: input.occurredAt,
      title: input.subject || '(No subject)',
      fields: { [medium.name]: 'email' },
      participants,
      about: [],
    });
    if (!event.created)
      throw new AppError(409, 'gmail_identity_conflict', 'Gmail evidence identity already in use');
    messageId = event.id;
    await tx`insert into gmail_messages(workspace_id,event_id,thread_group_id,occurred_at,original_date,body)
      values(${workspaceId},${messageId},${threadGroupId},${new Date(input.occurredAt)},
        ${input.originalDate ? new Date(input.originalDate) : null},${input.body})`;
  }
  if (!prior)
    await tx`insert into gmail_deliveries(workspace_id,installation_id,connection_id,message_id,provider_message_id,provider_thread_id)
      values(${workspaceId},${binding.installationId},${binding.connectionId},${messageId},${input.messageId},${input.threadId})`;
  if (groups.length > 1) {
    const otherGroups = groups.slice(1).map((group) => group.id);
    await tx`update gmail_messages set thread_group_id=${threadGroupId}
      where workspace_id=${workspaceId} and thread_group_id=any(${otherGroups}::uuid[])`;
  }
  const [representative] = await tx<{ id: string }[]>`
    select event_id as id from gmail_messages where workspace_id=${workspaceId} and thread_group_id=${threadGroupId}
    order by occurred_at desc,event_id desc limit 1`;
  if (!representative) throw new Error('Gmail conversation has no evidence');
  const people = await tx<{ record_id: string }[]>`
    select distinct l.record_id from gmail_messages m
    join event_links l on l.workspace_id=m.workspace_id and l.event_id=m.event_id
    join records r on r.id=l.record_id and r.workspace_id=l.workspace_id
    where m.workspace_id=${workspaceId} and m.thread_group_id=${threadGroupId}
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

/** Read bounded evidence separately from the activity record's core fields. */
export async function gmailConversationPage(
  tx: Tx,
  workspaceId: string,
  eventId: string,
  after: string | null,
  eventTypes: readonly string[],
) {
  const [group] = await tx<{ thread_group_id: string }[]>`
    select m.thread_group_id from gmail_messages m join records r on r.id=m.event_id and r.workspace_id=m.workspace_id
    where m.workspace_id=${workspaceId} and m.event_id=${eventId} and r.deleted_at is null
      and r.object_type_id=any(${eventTypes}::uuid[])`;
  if (!group) throw notFound('Gmail conversation');
  if (after) {
    const [cursor] = await tx`select 1 from gmail_messages
      where workspace_id=${workspaceId} and event_id=${after} and thread_group_id=${group.thread_group_id}`;
    if (!cursor) throw notFound('Gmail conversation cursor');
  }
  const messages = await tx<
    { id: string; occurred_at: Date; original_date: Date | null; body: string }[]
  >`
    select m.event_id as id,m.occurred_at,m.original_date,m.body from gmail_messages m
    join records r on r.id=m.event_id and r.workspace_id=m.workspace_id
    where m.workspace_id=${workspaceId} and m.thread_group_id=${group.thread_group_id} and r.deleted_at is null
      and r.object_type_id=any(${eventTypes}::uuid[])
      and (${after}::uuid is null or (m.occurred_at,m.event_id) >
        (select c.occurred_at,c.event_id from gmail_messages c where c.event_id=${after}))
    order by m.occurred_at,m.event_id limit 6`;
  const page = messages.slice(0, 5).map((message) => ({
    id: message.id,
    occurredAt: message.occurred_at.toISOString(),
    originalDate: message.original_date?.toISOString() ?? null,
    body: message.body,
  }));
  return {
    messages: page,
    nextAfter: messages.length > page.length ? (page.at(-1)?.id ?? null) : null,
  };
}
