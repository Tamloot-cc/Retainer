import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { BASE_EVENT_TYPE_IDS, BASE_FIELD_IDS, BASE_OBJECT_IDS } from '@retainer/shared';
import { z } from 'zod';

export const TAMLOOT = {
  registration: '54326882-cc28-4983-a5fe-cf0298520b68',
  connect: '562064c1-ea17-4c2b-9e92-6b2741154190',
  scan: '0c0f3520-c561-4f02-9d44-8bd6df4613d4',
  poll: 'f73caeba-09d4-4c76-b36c-a5d157ad67f8',
  sync: '20542a5c-65fb-4593-9336-f6f61014806e',
  taskIdField: '72ef5898-253b-4335-bcdb-50dfc8031095',
} as const;
export const TAMLOOT_FUNCTION_IDS: string[] = [
  TAMLOOT.connect,
  TAMLOOT.scan,
  TAMLOOT.poll,
  TAMLOOT.sync,
];
export const tamlootRevision = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger)
  .transform(String);
const email = z
  .email()
  .max(320)
  .transform((s) => s.toLowerCase());
export const tamlootMe = z.object({ data: z.object({ user_id: z.uuid(), email }) });
export const tamlootHead = z.object({ data: z.object({ cursor: z.string().min(1).max(8000) }) });
export const tamlootChanges = z.object({
  data: z
    .array(
      z.object({
        entity: z.enum(['session', 'task']),
        entity_id: z.uuid(),
        session_id: z.uuid().nullable(),
        op: z.enum(['upsert', 'delete']),
        revision: tamlootRevision,
      }),
    )
    .max(500),
  next_cursor: z.string().min(1).max(8000),
  has_more: z.boolean(),
});
export const tamlootSessions = z.object({
  data: z.array(z.object({ id: z.uuid(), recording_status: z.string() })).max(25),
  pagination: z.object({
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
  }),
});
export const tamlootSession = z.object({
  data: z.object({
    id: z.uuid(),
    revision: tamlootRevision,
    session_date: z.iso.datetime({ offset: true }),
    title: z.string().max(500).nullable(),
    recording_status: z.string(),
    participants: z
      .array(z.object({ name: z.string().max(200).nullable(), emails: z.array(email).max(200) }))
      .max(200),
    notes: z.array(z.object({ title: z.string().nullable(), content: z.string().nullable() })),
  }),
});
export const tamlootTasks = z.object({
  data: z
    .array(
      z.object({
        id: z.uuid(),
        content: z.string().min(1).max(20000),
        status: z.enum(['open', 'done']),
        contact_emails: z.array(email).max(200),
      }),
    )
    .max(500),
});
export function tamlootManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  serverRange: string;
}): ExtensionManifest {
  const empty = { type: 'object', additionalProperties: false };
  const fn = (
    universalId: string,
    name: string,
    trigger: unknown,
    inputSchema: unknown = empty,
  ) => ({
    universalId,
    name,
    description: 'Synchronize Tamloot meetings and tasks for the connected member.',
    handlerDigest: build.handlerDigest,
    timeoutSeconds: 120,
    trigger,
    inputSchema,
    secrets: ['apiKey'],
    scopes: ['read', 'write'],
  });
  return defineExtension({
    manifestVersion: 1,
    universalId: TAMLOOT.registration,
    name: 'tamloot',
    version: build.version ?? '1.0.0',
    description:
      'Share each connected member’s completed Tamloot meetings and tasks with this workspace.',
    packageDigest: build.packageDigest,
    serverRange: build.serverRange,
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'member',
    createPeople: 'everyone',
    onSourceDelete: 'retract',
    settings: {
      shareMeetings: {
        type: 'boolean',
        label: 'Allow members to share Tamloot meetings with this workspace',
        required: true,
        consent: true,
        default: false,
        secret: false,
        reconnect: false,
        description:
          'Everyone in this workspace can read imported meetings, notes, participants and tasks.',
      },
      createPeople: {
        type: 'string',
        label: 'Create contacts',
        required: true,
        default: 'everyone',
        options: ['never', 'everyone'],
        secret: false,
        reconnect: false,
      },
      apiKey: {
        type: 'string',
        label: 'Tamloot read-only API key',
        level: 'connection',
        required: true,
        secret: true,
        reconnect: true,
        description: 'Create a read-only key in Tamloot Settings → API keys.',
      },
      backfillDays: {
        type: 'number',
        label: 'Days of history',
        level: 'connection',
        required: true,
        default: 31,
        secret: false,
        reconnect: true,
        description:
          'Choose a whole number from 1 to 3650. Previously imported meetings are also checked on reconnect.',
      },
    },
    source: {
      provider: 'tamloot',
      identity: 'account',
      verifyFunctionId: TAMLOOT.connect,
      syncFunctionIds: [TAMLOOT.sync],
      scanFunctionIds: [TAMLOOT.scan, TAMLOOT.poll],
      eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
      revisionOrder: 'integer',
      tasks: {
        objectId: BASE_OBJECT_IDS.task,
        identityFieldId: TAMLOOT.taskIdField,
        titleFieldId: '5f37aa96-fac8-4572-9647-6b0da5d6d0c8',
        statusFieldId: BASE_FIELD_IDS.taskStatus,
        personFieldId: '3d66fcfe-2e9c-4aeb-a88a-7d6b3c2194ba',
        statuses: { open: 'todo', done: 'done' },
      },
    },
    schema: [
      {
        kind: 'field',
        objectId: BASE_OBJECT_IDS.task,
        definition: {
          universalId: TAMLOOT.taskIdField,
          name: 'tamlootTaskId',
          isSearchable: false,
          label: 'Tamloot task ID',
          type: 'text',
          isNullable: true,
          isUnique: true,
        },
      },
    ],
    views: [],
    functions: [
      fn(TAMLOOT.connect, 'connect', { kind: 'connect' }),
      fn(
        TAMLOOT.poll,
        'poll',
        { kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { scheduledAt: { type: 'string' } },
          required: ['scheduledAt'],
        },
      ),
      fn(
        TAMLOOT.scan,
        'scan',
        { kind: 'job' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            scanId: { type: 'string', maxLength: 36 },
            from: { type: 'string', maxLength: 50 },
            through: { type: 'string', maxLength: 50 },
            mode: { type: 'string', maxLength: 10 },
          },
          required: ['scanId', 'from', 'through', 'mode'],
        },
      ),
      fn(
        TAMLOOT.sync,
        'sync-session',
        { kind: 'job' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { sourceItemId: { type: 'string', maxLength: 36 } },
          required: ['sourceItemId'],
        },
      ),
    ],
  });
}
