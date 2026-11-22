import { randomUUID } from 'node:crypto';
import { gmailManifest } from '@retainer/runner/gmail-contract';
import type { Actor } from '@retainer/shared';
import { expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { inWorkspace } from '../../src/db/tx.js';
import { resolveBindingPlan } from '../../src/extensions/bindings.js';
import { withWrite } from '../../src/records/service.js';
import { loadSchemaState } from '../../src/schema/load.js';
import { appendGmailMessage, gmailMessageSchema } from '../../src/sources/gmail.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const admin: Actor = { type: 'user', id: 'admin' };

async function setup() {
  const app = startTestApp(db);
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Gmail evidence ${randomUUID()}` },
    { admin: { actor: admin, scopes: ['admin'] } },
  );
  const ws = workspace.id;
  const manifest = gmailManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  async function planFor(type: string) {
    const schema = await inWorkspace(db.owner, ws, (tx) => loadSchemaState(tx, ws));
    return resolveBindingPlan(
      schema,
      manifest,
      {
        email: { action: 'existing', objects: [type] },
      },
      null,
      'never',
    ).plan;
  }
  const plan = await planFor('conversation');
  const [installation] = await db.owner`
    insert into extension_installations
      (workspace_id,registration_id,version,release_digest,granted_actor,granted_scopes,created_by,state,bindings,bindings_revision)
    values (${ws},${randomUUID()},'1.0.0',${'a'.repeat(64)},'integration','["read","write"]',${db.owner.json(admin)},'active',${db.owner.json(plan)},1)
    returning id`;
  if (!installation) throw new Error('missing installation');
  const installationId = installation.id as string;
  async function mailbox(owner: string) {
    const [connection] = await db.owner`
      insert into extension_connections (workspace_id,installation_id,owner_id,owner,state)
      values(${ws},${installationId},${owner},${db.owner.json({ type: 'user', id: owner })},'active')
      returning id`;
    if (!connection) throw new Error('missing connection');
    return { installationId, connectionId: connection.id as string, plan };
  }
  async function person(email: string) {
    const created = await app.request('/v1/objects/person/records', {
      key: keys.admin,
      body: {
        values: { name: { first: 'Dana', last: '' }, emails: { primary: email, additional: [] } },
      },
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }
  const caller: Caller = {
    workspaceId: ws,
    actor: { type: 'integration', id: installationId },
    scopes: ['read', 'write'],
  };
  async function save(
    binding: Awaited<ReturnType<typeof mailbox>>,
    values: Partial<Parameters<typeof appendGmailMessage>[3]> = {},
  ) {
    const input = gmailMessageSchema.parse({
      messageId: 'message-a',
      threadId: 'thread-a',
      rfcMessageId: '<message-a@example.com>',
      occurredAt: '2026-01-04T12:00:00Z',
      subject: 'Renewal',
      body: 'Original body.',
      from: ['dana@example.com'],
      to: ['sales@example.com'],
      ...values,
    });
    return withWrite(
      app.sql,
      caller,
      (tx, context) => appendGmailMessage(tx, context, binding, input),
      { schema: 'exclusive' },
      { asPerson: false },
    );
  }
  return { app, ws, keys, mailbox, person, save, planFor };
}

it('atomically imports, deduplicates across mailboxes and preserves both citation paths on a late thread join', async () => {
  const h = await setup();
  const [one, two] = await Promise.all([h.mailbox('one'), h.mailbox('two')]);
  expect(await h.save(one)).toEqual({ kind: 'no_match' });
  await h.person('dana@example.com');
  const [first, replay] = await Promise.all([h.save(one), h.save(one)]);
  expect(first.kind).toBe('imported');
  expect(replay.kind).toBe('imported');
  if (first.kind !== 'imported' || replay.kind !== 'imported') throw new Error('missing evidence');
  expect(first.messageId).toBe(replay.messageId);
  expect([first.created, replay.created].sort()).toEqual([false, true]);
  const second = await h.save(two, {
    messageId: 'message-b',
    threadId: 'thread-b',
    rfcMessageId: '<message-b@example.com>',
    occurredAt: '2026-01-05T12:00:00Z',
    body: 'Follow-up body.',
  });
  if (second.kind !== 'imported') throw new Error('missing reply');
  const overlap = await h.save(two, { messageId: 'overlap-a', threadId: 'thread-b' });
  expect(overlap).toEqual({
    kind: 'imported',
    messageId: first.messageId,
    eventId: second.messageId,
    created: false,
  });
  const active = await h.app.request('/v1/events/query', {
    key: h.keys.admin,
    body: { filter: { type: { eq: 'conversation' } } },
  });
  expect(active.status).toBe(200);
  const current = active.body.records;
  expect(current).toHaveLength(1);
  const page = await h.app.request(`/v1/events/${first.messageId}/content`, {
    key: h.keys.admin,
  });
  expect(page.status).toBe(200);
  expect(page.body.parts.map((part: { id: string }) => part.id)).toEqual([
    first.messageId,
    second.messageId,
  ]);
  expect(await db.owner`select 1 from gmail_deliveries where workspace_id=${h.ws}`).toHaveLength(3);
  expect((await h.app.request(`/v1/events/${first.messageId}`, { key: h.keys.admin })).status).toBe(
    200,
  );
  const removed = await h.app.request(`/v1/events/${second.messageId}`, {
    key: h.keys.admin,
    method: 'DELETE',
  });
  expect(removed.status).toBe(200);
  expect(
    (await h.app.request(`/v1/events/${first.messageId}/content`, { key: h.keys.admin })).status,
  ).toBe(404);
  expect(await h.save(two, { messageId: 'late-message', threadId: 'thread-b' })).toEqual({
    kind: 'removed',
  });
});

it('checks targeted matches during the write and isolates Gmail evidence across workspaces', async () => {
  const h = await setup();
  const mailbox = await h.mailbox('one');
  const person = await h.person('dana@example.com');
  expect(
    await h.save(mailbox, { targetEmail: 'dana@example.com', targetPersonId: randomUUID() }),
  ).toEqual({ kind: 'no_match' });
  const result = await h.save(mailbox, { targetEmail: 'dana@example.com', targetPersonId: person });
  if (result.kind !== 'imported') throw new Error('missing evidence');
  const other = await setup();
  expect(
    (await h.app.request(`/v1/events/${result.eventId}/content`, { key: other.keys.admin })).status,
  ).toBe(404);
});

it('uses a custom email type without moving an older duplicate or joining its thread', async () => {
  const h = await setup();
  await h.person('dana@example.com');
  const original = await h.save(await h.mailbox('original'));
  if (original.kind !== 'imported') throw new Error('missing original message');
  const changed = await h.app.request('/v1/schema/changes', {
    key: h.keys.admin,
    body: {
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'mail',
            namePlural: 'mailMessages',
            labelSingular: 'Mail',
            labelPlural: 'Mail messages',
            fields: [
              {
                name: 'medium',
                label: 'Medium',
                type: 'select',
                settings: { options: [{ value: 'email', label: 'Email' }] },
              },
            ],
          },
        },
      ],
    },
  });
  expect(changed.status).toBe(200);
  const mailbox = { ...(await h.mailbox('new-destination')), plan: await h.planFor('mail') };
  const duplicate = await h.save(mailbox, { messageId: 'duplicate-a' });
  expect(duplicate).toEqual({ ...original, created: false });
  const reply = await h.save(mailbox, {
    messageId: 'reply-a',
    rfcMessageId: '<reply-a@example.com>',
    occurredAt: '2026-01-05T12:00:00Z',
    subject: 'Reply',
  });
  if (reply.kind !== 'imported') throw new Error('missing reply');
  const deliveries = await db.owner`
    select o.name_singular, b.thread_id from event_bodies b
    join records r on r.id=b.event_id join object_types o on o.id=r.object_type_id
    where b.workspace_id=${h.ws} order by b.occurred_at`;
  expect(deliveries.map((item) => item.name_singular)).toEqual(['conversation', 'mail']);
  expect(deliveries[0]?.thread_id).not.toBe(deliveries[1]?.thread_id);
});

it('accepts a non-unique match field and skips an ambiguous email', async () => {
  const h = await setup();
  const mailbox = await h.mailbox('one');
  const changed = await h.app.request('/v1/schema/changes', {
    key: h.keys.admin,
    body: {
      operations: [{ op: 'update_field', object: 'person', field: 'emails', isUnique: false }],
    },
  });
  expect(changed.status).toBe(200);
  await h.person('dana@example.com');
  await h.person('dana@example.com');
  expect(await h.save(mailbox)).toEqual({ kind: 'no_match' });
});
