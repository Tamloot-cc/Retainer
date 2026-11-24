import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { z } from 'zod';

export const GRANOLA = {
  registration: '9e427713-3c8a-4981-872c-c8db69703113',
  setup: '0b942cbe-65fe-48bf-8bcc-88c246729770',
  scan: 'c577234d-2a86-4ea6-9009-aa73e8f6dc42',
  schedule: '78f3e87b-46c6-4cd0-a2fa-32363172f792',
  sync: 'd312a7d3-1c09-44d2-8c42-c090859dcbaa',
  cleanup: 'a457ce52-c584-4fd7-9866-c5e51b013959',
  verifier: '0db0d1f8-a41f-4462-8c94-1cdc63bf942a',
  urlField: '0833a814-d14f-4700-915a-10fae4d3c279',
} as const;
export const GRANOLA_FUNCTION_IDS: string[] = [
  GRANOLA.setup,
  GRANOLA.scan,
  GRANOLA.schedule,
  GRANOLA.sync,
  GRANOLA.cleanup,
];
export const granolaNoteId = z
  .string()
  .regex(/^not_[a-z0-9]{14}$/i)
  .transform((s) => s.toLowerCase());
export const granolaTime = z.iso.datetime({ offset: true });
const person = z.object({
  email: z
    .email()
    .max(320)
    .transform((s) => s.toLowerCase()),
  name: z.string().max(200).nullable().optional(),
});
export const granolaSegment = z.object({
  speaker: z.object({
    source: z.string().max(100),
    attribution: z.string().max(100).optional(),
    diarization_label: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
  }),
  text: z.string(),
  start_time: granolaTime,
  end_time: granolaTime,
});
export const granolaNote = z.object({
  id: granolaNoteId,
  title: z.string().max(500).nullable(),
  owner: person,
  created_at: granolaTime,
  updated_at: granolaTime,
  deleted_at: granolaTime.nullable(),
  web_url: z
    .url()
    .max(2000)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }),
  summary_text: z.string().max(20000),
  attendees: z.array(person).max(200),
  calendar_event: z
    .object({
      organiser: z.email().nullable(),
      invitees: z.array(person).max(200),
      scheduled_start_time: granolaTime.nullable(),
    })
    .nullable(),
  transcript: z.array(granolaSegment).nullable().optional(),
});
export const granolaList = z.object({
  notes: z.array(z.object({ id: granolaNoteId, updated_at: granolaTime })).max(30),
  hasMore: z.boolean(),
  cursor: z.string().min(1).max(8000).nullable(),
});
export const granolaTranscriptPage = z.object({
  transcript: z.array(granolaSegment),
  hasMore: z.boolean(),
  cursor: z.string().min(1).max(8000).nullable(),
});
export const granolaEndpoint = z.object({
  id: z.string().regex(/^whe_[A-Za-z0-9]{14}$/),
  url: z.url(),
  url_redacted: z.boolean(),
  scopes: z.array(z.string()),
  created_by: z.unknown(),
  enabled: z.boolean(),
  events: z.array(z.string()),
  folder_ids: z.array(z.string()),
  signing_secret: z.string().optional(),
});
export const granolaEndpointList = z.object({
  webhook_endpoints: z.array(granolaEndpoint).max(1000),
});
export const GRANOLA_EVENTS = ['note.access_granted', 'note.edited', 'note.generated'];

/** API access is verified, while the human explicitly approves sharing everything this credential can read. */
export function granolaManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  verifierDigest: string;
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
    description: 'Synchronize shared Granola meeting evidence through the public API.',
    handlerDigest: universalId === GRANOLA.verifier ? build.verifierDigest : build.handlerDigest,
    timeoutSeconds: universalId === GRANOLA.verifier ? 5 : universalId === GRANOLA.sync ? 300 : 120,
    trigger,
    inputSchema,
    // Every run reads the API key; only setup registers webhooks and stores their
    // signing secret. The verifier gets its signing secret through webhook
    // admission, never a run credential. Cleanup only removes provider hooks.
    secrets:
      universalId === GRANOLA.verifier
        ? []
        : universalId === GRANOLA.setup
          ? ['apiKey', 'signing']
          : ['apiKey'],
    scopes:
      universalId === GRANOLA.verifier || universalId === GRANOLA.cleanup
        ? ['read']
        : ['read', 'write'],
  });
  return defineExtension({
    manifestVersion: 1,
    universalId: GRANOLA.registration,
    name: 'granola',
    version: build.version ?? '1.0.0',
    description:
      'Import shared summaries and transcripts, as text and as files, from an explicitly shared Granola API credential. Private notes and photos are excluded.',
    packageDigest: build.packageDigest,
    serverRange: build.serverRange,
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'everyone',
    onSourceDelete: 'keep',
    settings: {
      apiKey: {
        type: 'string',
        label: 'Granola API key',
        required: true,
        secret: true,
        reconnect: true,
        description:
          'This credential is shared with the Retainer workspace. Webhooks require a workspace API key.',
      },
      shareAccessibleNotes: {
        type: 'boolean',
        label: 'Share accessible Granola notes with this workspace',
        required: true,
        consent: true,
        default: false,
        reconnect: true,
        secret: false,
        description:
          'Everyone in this Retainer workspace can read the shared summaries and transcripts this key can access. This does not verify ownership of the Granola organization.',
      },
      createPeople: {
        type: 'string',
        label: 'Create people',
        required: true,
        default: 'never',
        options: ['never', 'contacted_first', 'everyone'],
        secret: false,
        reconnect: false,
      },
      backfillDays: {
        type: 'number',
        label: 'Days of initial history',
        required: true,
        default: 31,
        secret: false,
        reconnect: false,
        description:
          '1–3650 days. Increase and enable again to rescan older notes, including newly shared unchanged notes outside the initial window.',
      },
      webhooks: {
        type: 'boolean',
        label: 'Enable public webhooks',
        required: true,
        default: false,
        secret: false,
        reconnect: false,
        description:
          'Requires public HTTPS and a Granola workspace API key. Polling continues every 15 minutes.',
      },
      signing: {
        type: 'string',
        label: 'Webhook signing secret',
        secret: true,
        generated: true,
        required: false,
        reconnect: false,
      },
    },
    source: {
      provider: 'granola',
      identity: 'global-resource',
      verifyFunctionId: GRANOLA.setup,
      syncFunctionIds: [GRANOLA.sync],
      scanFunctionIds: [GRANOLA.scan, GRANOLA.schedule],
      event: 'meeting',
      people: 'person',
      revisionOrder: 'timestamp',
    },
    webhooks: [
      {
        route: 'notes',
        verifierFunctionId: GRANOLA.verifier,
        syncFunctionId: GRANOLA.sync,
        secretSetting: 'signing',
        headers: ['webhook-id', 'webhook-timestamp', 'webhook-signature'],
        optional: true,
      },
    ],

    bindings: [
      {
        key: 'meeting',
        label: 'Meetings',
        description: 'Granola meetings with shared summaries, links and transcripts.',
        class: 'event',
        access: 'write',
        creates: true,
        required: true,
        fields: [
          {
            key: 'url',
            label: 'Granola note',
            description: "A link to the meeting's note in Granola.",
            types: ['links'],
            required: false,
            create: {
              universalId: GRANOLA.urlField,
              name: 'granolaUrl',
              label: 'Granola note',
              type: 'links',
              description: "A link to the meeting's note in Granola.",
            },
          },
          {
            key: 'medium',
            label: 'Medium',
            description: 'How the conversation took place. Granola meetings are always meetings.',
            types: ['select'],
            required: false,
            values: ['meeting'],
            create: {
              universalId: 'ba7d267f-9002-4f3e-b356-34583ef1f926',
              name: 'medium',
              label: 'Medium',
              type: 'select',
              description: 'How the conversation took place, such as a meeting.',
              settings: { options: [{ value: 'meeting', label: 'Meeting' }] },
            },
          },
          {
            key: 'transcript',
            label: 'Transcript',
            description: "The meeting's transcript, as a file.",
            types: ['files'],
            required: false,
            create: {
              universalId: 'dfb41235-a285-46a6-af49-48ce1f277464',
              name: 'transcript',
              label: 'Transcript',
              type: 'files',
              description: "The meeting's transcript.",
            },
          },
        ],
        create: {
          universalId: '6b8880bb-05a5-4deb-9fad-d51056747091',
          nameSingular: 'conversation',
          namePlural: 'conversations',
          labelSingular: 'Conversation',
          labelPlural: 'Conversations',
          description:
            'Meetings, calls, emails and chats with the people the workspace works with.',
          fields: [],
        },
      },
      {
        key: 'person',
        label: 'People',
        description: 'Match or create people by the approved email field.',
        class: 'entity',
        access: 'write',
        required: false,
        match: 'emails',
        fields: [
          {
            key: 'name',
            label: 'Name',
            description: "A meeting participant's full name.",
            types: ['full_name', 'text'],
            required: false,
            create: {
              universalId: '3b20d1f6-06f6-4a1c-ae1d-5c7734f57777',
              name: 'name',
              label: 'Name',
              type: 'full_name',
              description: "The person's full name.",
            },
          },
          {
            key: 'emails',
            label: 'Emails',
            description: "A meeting participant's email addresses, used to match them to a person.",
            types: ['emails'],
            required: true,
            create: {
              universalId: '714c634a-9d88-41fa-8264-f66b0396cb55',
              name: 'emails',
              label: 'Emails',
              type: 'emails',
              description: "The person's email addresses.",
            },
          },
        ],
        create: {
          universalId: '81303fa3-a66c-484e-b6d0-689edce4206e',
          nameSingular: 'person',
          namePlural: 'people',
          labelSingular: 'Person',
          labelPlural: 'People',
          description: 'People the workspace works with.',
          labelField: 'name',
          fields: [],
        },
      },
    ],
    views: [],
    functions: [
      fn(GRANOLA.setup, 'setup', { kind: 'install' }),
      fn(GRANOLA.cleanup, 'cleanup', { kind: 'uninstall' }),
      fn(
        GRANOLA.schedule,
        'catch-up',
        { kind: 'schedule', cron: '*/15 * * * *', timezone: 'UTC' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { scheduledAt: { type: 'string' } },
          required: ['scheduledAt'],
        },
      ),
      fn(
        GRANOLA.scan,
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
        GRANOLA.sync,
        'import-note',
        { kind: 'job' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { sourceItemId: { type: 'string', maxLength: 36 } },
          required: ['sourceItemId'],
        },
      ),
      fn(GRANOLA.verifier, 'verify-note', { kind: 'route', route: 'notes' }),
    ] as ExtensionManifest['functions'],
  });
}
