import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileSchema } from '../schema/compiled.js';
import { sourceTaskBatchSchema } from './contract.js';
import { taskIdentityChannel, taskSchema } from './tasks.js';

describe('managed task contract', () => {
  it('rejects duplicate identities, unknown properties and unbounded snapshots', () => {
    const task = { externalId: 'one', title: 'Action', status: 'open', contactEmails: [] };
    expect(
      sourceTaskBatchSchema.safeParse({
        expectedRevisionId: null,
        expectedTaskRevision: 0,
        tasks: [task],
        complete: true,
      }).success,
    ).toBe(true);
    expect(
      sourceTaskBatchSchema.safeParse({
        expectedRevisionId: null,
        expectedTaskRevision: 0,
        tasks: [task, task],
        complete: true,
      }).success,
    ).toBe(false);
    expect(
      sourceTaskBatchSchema.safeParse({
        expectedRevisionId: null,
        expectedTaskRevision: 0,
        tasks: [],
        complete: true,
        actor: 'user',
      }).success,
    ).toBe(false);
    expect(
      sourceTaskBatchSchema.safeParse({
        expectedRevisionId: null,
        expectedTaskRevision: 0,
        tasks: Array.from({ length: 501 }, (_, i) => ({ ...task, externalId: String(i) })),
        complete: true,
      }).success,
    ).toBe(false);
  });
  it('fails closed when reviewed bindings are absent and keeps task tombstones separate from source tombstones', () => {
    const result = taskSchema(compileSchema({ objects: [] }, 1), {
      provider: 'fixture',
      identity: 'account',
      verifyFunctionId: randomUUID(),
      syncFunctionIds: [randomUUID()],
      eventTypeIds: [randomUUID()],
      revisionOrder: 'integer',
      tasks: {
        objectId: randomUUID(),
        identityFieldId: randomUUID(),
        titleFieldId: randomUUID(),
        statusFieldId: randomUUID(),
        statuses: { open: 'todo', done: 'done' },
      },
    });
    expect(result.response.status).toBe('degraded');
    expect(result.response.errors.map((e) => e.field)).toContain('task');
    expect(taskIdentityChannel('a', 'b', 'c')).not.toBe(taskIdentityChannel('a', 'bc', ''));
    expect(taskIdentityChannel('a', 'b', 'c')).toMatch(/^retainer-task:/);
  });
});
