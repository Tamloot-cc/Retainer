import {
  defineExtension,
  type ExtensionBinding,
  type ExtensionManifest,
} from '@retainer/extension';

export const BOOKING_OAUTH_CLIENT_ID = 'retainer-booking';
export const BOOKING_REGISTRATION_ID = '5af34474-16c9-4f79-9601-2a459b236bdb';

const writes = [
  ['bookingId', 'Booking ID', 'text', '466d2f87-bf8e-4081-b285-71e83bd1a012'],
  ['bookingTypeId', 'Booking type ID', 'text', 'ad6bc424-7244-4d88-a780-f20593acdf40'],
  ['title', 'Title', 'text', '1bd98e70-0953-402c-b028-cb825afce2ef'],
  ['guestEmail', 'Guest email', 'text', '76345a25-0906-4f6b-8932-569927d55ad6'],
  ['startsAt', 'Starts at', 'date_time', '5b26e444-bc7f-43eb-b5bc-be169a43edc3'],
  ['endsAt', 'Ends at', 'date_time', '2cf659ae-b477-4d36-a7a0-48fb15d420f2'],
  ['status', 'Status', 'text', '5414f11f-8cea-446f-a469-e64aaad75a1d'],
  ['manageUrl', 'Manage booking', 'links', 'bc78e5f2-b5e8-4c0a-a24b-8c7367148f4f'],
] as const;

const fields: ExtensionBinding['fields'] = writes.map(([key, label, type, universalId]) => ({
  key,
  label,
  types: [type],
  required: true,
  installationOnly: true,
  create: { universalId, name: key, label, type, isUnique: key === 'bookingId' },
}));

export function bookingManifest(build: {
  version: string;
  packageDigest: string;
  serverRange: string;
}): ExtensionManifest {
  return defineExtension({
    manifestVersion: 1,
    universalId: BOOKING_REGISTRATION_ID,
    name: 'booking',
    version: build.version,
    description: 'Show summaries from the standalone Booking app in a workspace.',
    packageDigest: build.packageDigest,
    serverRange: build.serverRange,
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'standalone',
    oauthClientId: BOOKING_OAUTH_CLIENT_ID,
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    schema: [],
    settings: {},
    views: [],
    functions: [],
    bindings: [
      {
        key: 'booking',
        label: 'Bookings',
        description: 'Booking summaries, synchronized by the app.',
        class: 'entity',
        access: 'write',
        required: true,
        creates: true,
        owned: true,
        fields: [
          ...fields,
          {
            key: 'person',
            label: 'Person',
            description: 'A person can link or correct this contact in the workspace.',
            types: ['relation'],
            required: false,
            lookup: true,
            target: 'person',
            create: {
              universalId: '3033afa2-beb4-4d31-b1cc-481c72e11761',
              name: 'person',
              label: 'Person',
              type: 'relation',
            },
          },
        ],
        create: {
          universalId: 'edf6ddf1-1494-4446-99a9-6fd01ab074e3',
          nameSingular: 'booking',
          namePlural: 'bookings',
          labelSingular: 'Booking',
          labelPlural: 'Bookings',
          labelField: 'title',
          fields: [],
        },
      },
      {
        key: 'person',
        label: 'People',
        description: 'Optional destination for the contact link maintained by workspace members.',
        class: 'entity',
        access: 'read',
        required: false,
        fields: [],
      },
    ],
  });
}
