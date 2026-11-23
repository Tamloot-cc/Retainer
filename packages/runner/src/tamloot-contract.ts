import {
  defineExtension,
  type ExtensionBinding,
  type ExtensionManifest,
} from '@retainer/extension';
import { z } from 'zod';

export const TAMLOOT = {
  registration: '54326882-cc28-4983-a5fe-cf0298520b68',
  connect: '562064c1-ea17-4c2b-9e92-6b2741154190',
  scan: '0c0f3520-c561-4f02-9d44-8bd6df4613d4',
  poll: 'f73caeba-09d4-4c76-b36c-a5d157ad67f8',
  sync: '20542a5c-65fb-4593-9336-f6f61014806e',
  disconnect: '0b6f1c7e-3d52-4a8e-9f1b-6c2d7e4a9b35',
  configure: 'd7d30cd8-8dbf-4632-88b2-3a7f3297c9bf',
} as const;
/** The model `configure` asks where meetings, tasks and people go. */
export const TAMLOOT_MODEL = 'claude-haiku-5-5';
export const TAMLOOT_FUNCTION_IDS: string[] = [
  TAMLOOT.connect,
  TAMLOOT.scan,
  TAMLOOT.poll,
  TAMLOOT.sync,
  TAMLOOT.disconnect,
  TAMLOOT.configure,
];
/** The connection secrets the release declares (connect spec 5.1). */
export const TAMLOOT_SECRETS = {
  key: 'apiKey',
  verifier: 'oauthVerifier',
  code: 'oauthCode',
  tokens: 'oauthTokens',
} as const;
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
/** What Tamloot writes, in its own words (no built-in objects spec 5). */
export const TAMLOOT_BINDINGS: ExtensionBinding[] = [
  {
    key: 'meeting',
    label: 'Meetings',
    description: 'Completed Tamloot meetings with notes and participants.',
    class: 'event',
    access: 'write',
    required: true,
    creates: true,
    fields: [],
    create: {
      universalId: '417516c1-3ef9-4830-9e49-bf66485e87ac',
      nameSingular: 'meeting',
      namePlural: 'meetings',
      labelSingular: 'Meeting',
      labelPlural: 'Meetings',
      fields: [],
    },
  },
  {
    key: 'task',
    label: 'Tasks',
    description: 'Action items from Tamloot meetings.',
    class: 'entity',
    access: 'write',
    required: false,
    creates: true,
    fields: [
      {
        key: 'title',
        label: 'Title',
        types: ['text'],
        required: true,
        create: {
          universalId: '373fdbab-f1bf-4bad-b86f-1a89213b7af0',
          name: 'title',
          label: 'Title',
          type: 'text',
          isNullable: false,
        },
      },
      {
        key: 'status',
        label: 'Status',
        types: ['select'],
        required: true,
        values: ['open', 'done'],
        create: {
          universalId: '516adff3-1f74-45ec-929b-aa589880232e',
          name: 'status',
          label: 'Status',
          type: 'select',
          isNullable: false,
          settings: {
            options: [
              { value: 'open', label: 'Open' },
              { value: 'done', label: 'Done' },
            ],
          },
        },
      },
      {
        key: 'person',
        label: 'Person',
        description: 'The contact associated with the action item.',
        types: ['relation'],
        required: false,
        target: 'person',
        create: {
          universalId: 'a4960a8d-6ec7-42d0-8471-dc5f50068b63',
          name: 'person',
          label: 'Person',
          type: 'relation',
        },
      },
    ],
    create: {
      universalId: 'f0db09e4-a6e1-4860-a44b-28a85a620c54',
      nameSingular: 'task',
      namePlural: 'tasks',
      labelSingular: 'Task',
      labelPlural: 'Tasks',
      labelField: 'title',
      fields: [],
    },
  },
  {
    key: 'person',
    label: 'People',
    description: 'Match and optionally create meeting participants by email address.',
    class: 'entity',
    access: 'write',
    required: false,
    match: 'emails',
    fields: [
      {
        key: 'name',
        label: 'Name',
        types: ['full_name', 'text'],
        required: false,
        create: {
          universalId: 'f1231700-7ebd-4d64-bf21-cd96277bae0f',
          name: 'name',
          label: 'Name',
          type: 'full_name',
        },
      },
      {
        key: 'emails',
        label: 'Emails',
        types: ['emails'],
        required: true,
        create: {
          universalId: 'dbf832c6-d812-4cd7-8426-37f466f086c1',
          name: 'emails',
          label: 'Emails',
          type: 'emails',
        },
      },
    ],
    create: {
      universalId: '40f55446-9e51-41af-a269-d45ecebd5e28',
      nameSingular: 'person',
      namePlural: 'people',
      labelSingular: 'Person',
      labelPlural: 'People',
      labelField: 'name',
      fields: [],
    },
  },
];
export function tamlootManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  serverRange: string;
}): ExtensionManifest {
  const empty = { type: 'object', additionalProperties: false };
  const { key, verifier, code, tokens } = TAMLOOT_SECRETS;
  const fn = (
    universalId: string,
    name: string,
    trigger: unknown,
    inputSchema: unknown = empty,
    secrets: string[] = [key, tokens],
  ) => ({
    universalId,
    name,
    description: 'Synchronize Tamloot meetings and tasks for the connected member.',
    handlerDigest: build.handlerDigest,
    timeoutSeconds: 120,
    trigger,
    inputSchema,
    secrets,
    scopes: ['read', 'write'],
  });
  const generated = (label: string) => ({
    type: 'string',
    label,
    level: 'connection',
    required: false,
    secret: true,
    generated: true,
    reconnect: false,
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
        required: false,
        secret: true,
        reconnect: true,
        description: 'Create a read-only key in Tamloot Settings → API keys.',
      },
      oauthVerifier: generated('Tamloot sign-in verifier'),
      oauthCode: generated('Tamloot sign-in code'),
      oauthTokens: generated('Tamloot session'),
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
    oauth: {
      verifierSetting: verifier,
      codeSetting: code,
      tokenSetting: tokens,
      keySetting: key,
      revokeUrl: 'https://app.tamloot.cc/dashboard/settings?tab=apps',
    },
    gettingStarted: {
      text: 'No meetings to import yet. Record a meeting with Tamloot and it shows up here a few minutes after it ends.',
      linkLabel: 'Open Tamloot',
      url: 'https://app.tamloot.cc',
    },
    source: {
      provider: 'tamloot',
      identity: 'account',
      verifyFunctionId: TAMLOOT.connect,
      syncFunctionIds: [TAMLOOT.sync],
      scanFunctionIds: [TAMLOOT.scan, TAMLOOT.poll],
      event: 'meeting',
      people: 'person',
      revisionOrder: 'integer',
      tasks: 'task',
    },
    bindings: TAMLOOT_BINDINGS,

    views: [],
    functions: [
      fn(TAMLOOT.connect, 'connect', { kind: 'connect' }, empty, [key, verifier, code, tokens]),
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
      {
        ...fn(TAMLOOT.configure, 'configure', { kind: 'configure' }, empty, []),
        description:
          'Suggest where meetings, tasks and people go, using a model, the workspace schema and a few records.',
        scopes: ['read'],
        uses: ['model'],
      },
      {
        ...fn(TAMLOOT.disconnect, 'disconnect', { kind: 'disconnect' }, empty, [tokens]),
        description: 'Give up the connection’s Tamloot sessions.',
        timeoutSeconds: 60,
      },
    ],
  });
}
