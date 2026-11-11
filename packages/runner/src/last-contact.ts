import { randomUUID } from 'node:crypto';
import { defineExtension, type ExecutionResult, type Invocation } from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { BASE_EVENT_TYPE_IDS, BASE_OBJECT_IDS } from '@retainer/shared';
import { z } from 'zod';

export const LAST_CONTACT = {
  registration: 'c1e8ba8a-69bb-4b2e-8db3-6ddc6c7b1606',
  setup: '391717df-ce74-4bc2-b6ad-e059029d9dbd',
  scan: '7c98a7ed-6c48-4a53-86a6-23fed616e248',
  schedule: 'f1fc952a-1c50-4c92-9bd7-3e7968c18c1e',
  person: '25c82830-4e75-4f8e-9650-e6369b2e5c17',
  company: 'bfe6409d-1482-45b6-a9ed-854c3ca9e3df',
  conversation: 'cdd33f41-8848-4b6b-97b3-e3f79d0f1dbf',
  personField: '7131412f-cc90-4a45-9482-3a9060bf9426',
  companyField: '92166eb2-4d95-477e-8db6-04ed3c0094f5',
} as const;
const changeIds: string[] = [LAST_CONTACT.person, LAST_CONTACT.company, LAST_CONTACT.conversation];
export const LAST_CONTACT_FUNCTION_IDS: string[] = [
  LAST_CONTACT.setup,
  LAST_CONTACT.scan,
  LAST_CONTACT.schedule,
  ...changeIds,
];
const empty = { type: 'object' as const, additionalProperties: false as const };
export function lastContactManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  serverVersions: string[];
}) {
  const fields = [
    { objectId: BASE_OBJECT_IDS.person, fieldId: LAST_CONTACT.personField },
    { objectId: BASE_OBJECT_IDS.company, fieldId: LAST_CONTACT.companyField },
  ];
  const fn = (
    universalId: string,
    name: string,
    trigger: unknown,
    inputSchema: unknown = empty,
  ) => ({
    universalId,
    name,
    description:
      'Maintain the most recent current conversation with ordinary assertion provenance.',
    handlerDigest: build.handlerDigest,
    timeoutSeconds: 120,
    trigger,
    inputSchema,
  });
  return defineExtension({
    manifestVersion: 1,
    universalId: LAST_CONTACT.registration,
    name: 'last-contact',
    version: build.version ?? '1.0.0',
    description:
      'Derive last contact from current conversation history, including one-hop event rollups. Human overrides keep normal precedence.',
    packageDigest: build.packageDigest,
    serverVersions: build.serverVersions,
    runtimeVersion: 'node24',
    execution: 'hosted',
    protocolVersion: 1,
    requestedActor: 'integration',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},
    views: [],
    schema: fields.map(({ objectId, fieldId }) => ({
      kind: 'field',
      objectId,
      definition: {
        universalId: fieldId,
        name: 'lastContactAt',
        label: 'Last contact',
        type: 'date_time',
        isNullable: true,
        isFilterable: true,
        description:
          'Most recent current conversation at or before now. Maintained by the Last contact extension; human assertions retain normal precedence.',
      },
    })),
    lastContact: { functionIds: [LAST_CONTACT.scan, LAST_CONTACT.schedule, ...changeIds], fields },
    functions: [
      fn(LAST_CONTACT.setup, 'setup', { kind: 'install' }),
      fn(LAST_CONTACT.scan, 'scan', { kind: 'job' }),
      fn(
        LAST_CONTACT.schedule,
        'recover',
        {
          kind: 'schedule',
          cron: '*/15 * * * *',
          timezone: 'UTC',
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: { scheduledAt: { type: 'string', maxLength: 100 } },
          required: ['scheduledAt'],
        },
      ),
      ...[
        { id: LAST_CONTACT.person, objectId: BASE_OBJECT_IDS.person, name: 'person-changed' },
        { id: LAST_CONTACT.company, objectId: BASE_OBJECT_IDS.company, name: 'company-changed' },
        {
          id: LAST_CONTACT.conversation,
          objectId: BASE_EVENT_TYPE_IDS.conversation,
          name: 'conversation-changed',
        },
      ].map(({ id, objectId, name }) =>
        fn(
          id,
          name,
          { kind: 'change', objectId, fieldIds: [] },
          {
            type: 'object',
            additionalProperties: false,
            properties: { changePosition: { type: 'string', maxLength: 19 } },
            required: ['changePosition'],
          },
        ),
      ),
    ],
  });
}
const cursor = z.strictObject({
  root: z.uuid(),
  startedBy: z.uuid(),
  page: z.number().int().nonnegative(),
  after: z.uuid().nullable(),
  through: z.uuid().nullable(),
  done: z.boolean(),
  lastSuccessfulScanAt: z.iso.datetime().nullable(),
});

/** Deterministic CRM projection; KV contains scan control only, never values, bodies or credentials. */
export async function executeLastContact(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: (url, init) => transport(url, { ...init, signal }),
  });
  const read = async () => {
    const row = await sdk.extensionKv(invocation.installationId, 'last-contact-scan');
    return { revision: row?.revision ?? null, state: row ? cursor.parse(row.value) : null };
  };
  const kick = async (setup = false) => {
    const { revision, state } = await read();
    if (setup && state?.startedBy === invocation.runId) return;
    const fresh = !state || state.done || setup;
    await sdk.extensionCheckpoint(invocation.installationId, {
      children: [
        { functionId: LAST_CONTACT.scan, input: {}, dedupeKey: `scan-kick:${invocation.runId}` },
      ],
      ...(fresh
        ? {
            kv: {
              key: 'last-contact-scan',
              expectedRevision: revision,
              value: {
                root: randomUUID(),
                startedBy: invocation.runId,
                page: 0,
                after: null,
                through: null,
                done: false,
                lastSuccessfulScanAt: state?.lastSuccessfulScanAt ?? null,
              },
            },
          }
        : {}),
    });
  };
  if (
    invocation.functionId === LAST_CONTACT.setup ||
    invocation.functionId === LAST_CONTACT.schedule
  ) {
    const input =
      invocation.functionId === LAST_CONTACT.schedule
        ? z.strictObject({ scheduledAt: z.iso.datetime() })
        : z.strictObject({});
    if (!input.safeParse(invocation.input).success)
      return { status: 'failed', code: 'invalid_input' };
    await kick(invocation.functionId === LAST_CONTACT.setup);
    return { status: 'succeeded' };
  }
  if (changeIds.includes(invocation.functionId)) {
    const input = z
      .strictObject({ changePosition: z.string().regex(/^[1-9][0-9]{0,18}$/) })
      .safeParse(invocation.input);
    if (!input.success) return { status: 'failed', code: 'invalid_input' };
    const change = await sdk.change(input.data.changePosition);
    const ids = [
      ...new Set([
        change.recordId,
        ...change.relatedRecordIds,
        ...(change.mergedIntoId ? [change.mergedIntoId] : []),
      ]),
    ];
    for (let offset = 0; offset < ids.length; offset += 20) {
      try {
        await sdk.reconcileLastContact(invocation.installationId, {
          kind: 'records',
          recordIds: ids.slice(offset, offset + 20),
        });
      } catch (error) {
        if (!(error instanceof RetainerApiError && error.code === 'derivation_fanout_exceeded'))
          throw error;
        await kick();
        break;
      }
    }
    return { status: 'succeeded' };
  }
  if (invocation.functionId !== LAST_CONTACT.scan)
    return { status: 'failed', code: 'function_not_bundled' };
  if (!z.strictObject({}).safeParse(invocation.input).success)
    return { status: 'failed', code: 'invalid_input' };
  const { revision, state: previous } = await read();
  if (previous?.done) return { status: 'succeeded' };
  const state = previous ?? {
    root: randomUUID(),
    startedBy: invocation.runId,
    page: 0,
    after: null,
    through: null,
    done: false,
    lastSuccessfulScanAt: null,
  };
  const page = await sdk.reconcileLastContact(invocation.installationId, {
    kind: 'scan',
    after: state.after,
    ...(state.through ? { through: state.through } : {}),
  });
  await sdk.extensionCheckpoint(invocation.installationId, {
    children: page.nextAfter
      ? [
          {
            functionId: LAST_CONTACT.scan,
            input: {},
            dedupeKey: `scan:${state.root}:${state.page + 1}`,
          },
        ]
      : [],
    kv: {
      key: 'last-contact-scan',
      expectedRevision: revision,
      value: {
        ...state,
        page: state.page + 1,
        after: page.nextAfter,
        through: page.through,
        done: page.nextAfter === null,
        lastSuccessfulScanAt:
          page.nextAfter === null ? new Date().toISOString() : state.lastSuccessfulScanAt,
      },
    },
  });
  return { status: 'succeeded' };
}
