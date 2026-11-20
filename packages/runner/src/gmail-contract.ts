import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { gmailRegistrationId } from '@retainer/extension/nango-gmail';
import { BASE_EVENT_TYPE_IDS } from '@retainer/shared';

export const GMAIL = {
  registration: gmailRegistrationId,
  connect: 'c14c9c6e-5218-492a-ab62-42dca936bfdc',
  disconnect: 'eb6ab2d8-d265-476b-acad-c3b2ca647fcb',
  poll: '49398b30-4c07-4ed5-886d-ba9c689eec6f',
  import: '135361a6-38de-458f-b9a3-7bc5a31e97b5',
} as const;
export const GMAIL_FUNCTION_IDS: string[] = [
  GMAIL.connect,
  GMAIL.disconnect,
  GMAIL.poll,
  GMAIL.import,
];

export function gmailManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  serverRange: string;
}): ExtensionManifest {
  const fn = (
    universalId: string,
    name: string,
    trigger: unknown,
    properties: Record<string, unknown>,
  ) => ({
    universalId,
    name,
    trigger,
    description: 'Capture qualifying correspondence in the connected Gmail mailbox.',
    handlerDigest: build.handlerDigest,
    timeoutSeconds: 100,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
    },
    secrets: [],
  });
  return defineExtension({
    manifestVersion: 1,
    universalId: GMAIL.registration,
    name: 'gmail',
    description: 'Capture read-only Gmail correspondence with People in Retainer.',
    version: build.version ?? '1.0.0',
    packageDigest: build.packageDigest,
    serverRange: build.serverRange,
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'member',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {
      historyDays: {
        type: 'number',
        label: 'Days of email history',
        required: true,
        default: 31,
        secret: false,
        reconnect: false,
      },
      nangoIntegrationId: {
        type: 'string',
        label: 'Nango Gmail integration',
        required: true,
        default: 'google-mail',
        secret: false,
        reconnect: true,
      },
      nangoConnectionId: {
        type: 'string',
        label: 'Verified Nango connection',
        level: 'connection',
        required: true,
        secret: false,
        reconnect: false,
      },
    },
    source: {
      provider: 'gmail',
      identity: 'account',
      verifyFunctionId: GMAIL.connect,
      scanFunctionIds: [GMAIL.poll],
      syncFunctionIds: [GMAIL.import],
      eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
      revisionOrder: 'opaque',
    },
    schema: [],
    views: [],
    functions: [
      fn(GMAIL.connect, 'connect', { kind: 'connect' }, {}),
      fn(GMAIL.disconnect, 'disconnect', { kind: 'disconnect' }, {}),
      fn(
        GMAIL.poll,
        'poll',
        { kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' },
        {
          scheduledAt: { type: 'string' },
        },
      ),
      fn(
        GMAIL.import,
        'import-message',
        { kind: 'job' },
        {
          sourceItemId: { type: 'string', maxLength: 36 },
        },
      ),
    ],
  });
}
