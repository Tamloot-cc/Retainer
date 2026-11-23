import { randomUUID } from 'node:crypto';
import { gmailManifest } from '@retainer/runner/gmail-contract';
import type { Actor } from '@retainer/shared';
import { expect } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { inWorkspace } from '../../src/db/tx.js';
import { resolveBindingPlan } from '../../src/extensions/bindings.js';
import { withWrite } from '../../src/records/service.js';
import { loadSchemaState } from '../../src/schema/load.js';
import { appendGmailMessage, gmailMessageSchema } from '../../src/sources/gmail.js';
import { startTestApp } from './app.js';
import type { TestDatabase } from './db.js';

const admin: Actor = { type: 'user', id: 'admin' };

export async function setupGmailEvidence(db: TestDatabase) {
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
