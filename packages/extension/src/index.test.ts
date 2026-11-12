import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  defineExtension,
  defineFunction,
  functionScopes,
  functionSecrets,
  lifecycleInputSchema,
} from './index.js';

export const fixture = () => ({
  manifestVersion: 1,
  universalId: '7cd3cfa3-9871-4527-9b5d-e36d47dce0f5',
  name: 'fixture',
  version: '1.0.0',
  description: 'Deterministic test fixture',
  packageDigest: 'a'.repeat(64),
  serverVersions: ['0.1.0'],
  runtimeVersion: 'node24',
  protocolVersion: 1,
  execution: 'hosted',
  requestedActor: 'integration',
  scopes: ['read', 'write'],
  connection: 'workspace',
  createPeople: 'never',
  onSourceDelete: 'keep',
  settings: { enabled: { type: 'boolean', label: 'Enabled', required: true } },
  schema: [],
  views: [],
  functions: [],
});
describe('strict extension contracts', () => {
  it('refuses secret defaults, invalid choice defaults and preselected sharing consent', () => {
    const setting = {
      type: 'string',
      label: 'Contact creation',
      options: ['never', 'everyone'],
      default: 'never',
    };
    expect(
      defineExtension({ ...fixture(), settings: { policy: setting } }).settings.policy?.default,
    ).toBe('never');
    for (const invalid of [
      { ...setting, secret: true },
      { ...setting, default: 'invalid' },
      { ...setting, options: ['never', 'never'] },
      { type: 'boolean', label: 'Share', required: true, consent: true, default: true },
    ])
      expect(() => defineExtension({ ...fixture(), settings: { policy: invalid } })).toThrow(
        'setting default',
      );
  });

  it('bounds change handlers to a local feed position and refuses caller-supplied record bodies', () => {
    const input = {
      ...fixture(),
      functions: [
        {
          universalId: 'f3f3e359-61f7-4115-9dc9-63d9184c2070',
          name: 'watch',
          description: 'Watch fields',
          handlerDigest: 'b'.repeat(64),
          trigger: {
            kind: 'change',
            objectId: 'e449a44f-0b0e-4c43-981c-f50fe507a6a7',
            fieldIds: [],
          },
          inputSchema: {
            type: 'object',
            properties: { changePosition: { type: 'string', maxLength: 19 } },
            required: ['changePosition'],
            additionalProperties: false,
          },
        },
      ],
    };
    expect(defineExtension(input).functions[0]?.trigger.kind).toBe('change');
    expect(() =>
      defineExtension({
        ...input,
        functions: [
          {
            ...input.functions[0],
            inputSchema: {
              type: 'object',
              properties: { body: { type: 'string', maxLength: 65536 } },
              required: ['body'],
              additionalProperties: false,
            },
          },
        ],
      }),
    ).toThrow('local changePosition');
  });
  it('requires the scheduler-owned UTC timestamp payload at registration', () => {
    const fn = {
      universalId: randomUUID(),
      name: 'poll',
      description: 'Scheduled poll',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'schedule', cron: '* * * * *', timezone: 'UTC' },
      inputSchema: {
        type: 'object',
        properties: { scheduledAt: { type: 'string', maxLength: 24 } },
        required: ['scheduledAt'],
        additionalProperties: false,
      },
    };
    expect(defineExtension({ ...fixture(), functions: [fn] }).functions).toHaveLength(1);
    for (const inputSchema of [
      { type: 'object', additionalProperties: false },
      { ...fn.inputSchema, required: [] },
      { ...fn.inputSchema, properties: { scheduledAt: { type: 'string', maxLength: 23 } } },
      { ...fn.inputSchema, properties: { ...fn.inputSchema.properties, body: { type: 'string' } } },
    ])
      expect(() => defineExtension({ ...fixture(), functions: [{ ...fn, inputSchema }] })).toThrow(
        'UTC scheduledAt',
      );
  });
  it('requires a pinned setup verifier and local-ID-only source ingestion jobs', () => {
    const verifyId = '5c011ac7-a6b8-4bc5-bac5-5c9b70491ab4',
      syncId = '50b706e0-2f74-46d4-b454-d9481ed21b24';
    const source = {
      provider: 'fixture',
      identity: 'account',
      verifyFunctionId: verifyId,
      syncFunctionIds: [syncId],
      eventTypeIds: ['d7eec2a6-7217-4923-9cf8-00673f706ab4'],
      revisionOrder: 'opaque',
    };
    const fn = { description: 'Source handler', handlerDigest: 'b'.repeat(64) };
    const functions = [
      {
        ...fn,
        universalId: verifyId,
        name: 'verify',
        trigger: { kind: 'install' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
      {
        ...fn,
        universalId: syncId,
        name: 'sync',
        trigger: { kind: 'job' },
        inputSchema: {
          type: 'object',
          properties: { sourceItemId: { type: 'string', maxLength: 36 } },
          required: ['sourceItemId'],
          additionalProperties: false,
        },
      },
    ];
    expect(defineExtension({ ...fixture(), source, functions }).source?.provider).toBe('fixture');
    expect(() => defineExtension({ ...fixture(), source, functions: functions.slice(1) })).toThrow(
      'source verification',
    );
    expect(() =>
      defineExtension({
        ...fixture(),
        source,
        functions: [
          functions[0],
          {
            ...functions[1],
            inputSchema: {
              type: 'object',
              properties: { transcript: { type: 'string', maxLength: 65536 } },
              required: ['transcript'],
              additionalProperties: false,
            },
          },
        ],
      }),
    ).toThrow('local sourceItemId');
  });
  it('produces a JSON manifest with explicit policy', () => {
    expect(defineExtension(fixture())).toMatchObject({
      createPeople: 'never',
      connection: 'workspace',
    });
  });
  it('rejects escalation, unknown kinds and remote code', () => {
    for (const update of [
      { requestedActor: 'system' },
      { requestedActor: 'user' },
      { manifestVersion: 2 },
      { moduleUrl: 'https://attacker.test/code.js' },
      { connection: 'personal' },
      { runtimeVersion: 'node26' },
    ]) {
      expect(() => defineExtension({ ...fixture(), ...update })).toThrow();
    }
  });
  it('bounds untrusted nesting and total bytes before parsing', () => {
    let deep: unknown = {};
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => defineExtension(deep)).toThrow('nesting');
    expect(() => defineExtension({ ...fixture(), description: 'a'.repeat(1048577) })).toThrow(
      'size',
    );
    const cyclic: { cycle?: unknown } = {};
    cyclic.cycle = cyclic;
    expect(() => defineExtension(cyclic)).toThrow('cyclic');
  });
  it('rejects duplicate identities and remote JSON Schema references', () => {
    const fn = {
      universalId: fixture().universalId,
      name: 'run',
      description: 'Run',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    };
    expect(() => defineExtension({ ...fixture(), functions: [fn] })).toThrow(
      'duplicate universal ID',
    );
    expect(() =>
      defineFunction({ ...fn, inputSchema: { $ref: 'https://attacker.test/schema' } }),
    ).toThrow();
    expect(() => defineFunction({ ...fn, trigger: { kind: 'tool' } })).toThrow();
    expect(() => defineFunction({ ...fn, timeoutSeconds: 301 })).toThrow();
    expect(() =>
      defineExtension({
        ...fixture(),
        settings: { key: { type: 'string', label: 'Key', secret: true, default: 'secret' } },
      }),
    ).toThrow();
  });
  it('allows optional provider-generated secrets but never treats them as required human settings', () => {
    const setting = { type: 'string', label: 'Signing secret', secret: true, generated: true };
    expect(
      defineExtension({ ...fixture(), settings: { signing: setting } }).settings.signing?.generated,
    ).toBe(true);
    expect(() =>
      defineExtension({ ...fixture(), settings: { signing: { ...setting, required: true } } }),
    ).toThrow('generated secrets');
    expect(() =>
      defineExtension({ ...fixture(), settings: { signing: { ...setting, secret: false } } }),
    ).toThrow('generated secrets');
  });
  it('pins webhook routing, source sync authority and a five-second verifier separately', () => {
    const installId = randomUUID(),
      syncId = randomUUID(),
      verifyId = randomUUID();
    const fn = (
      id: string,
      name: string,
      trigger: unknown,
      inputSchema: unknown,
      timeoutSeconds = 120,
    ) => ({
      universalId: id,
      name,
      trigger,
      inputSchema,
      timeoutSeconds,
      description: 'Fixture',
      handlerDigest: 'b'.repeat(64),
    });
    const valid = {
      ...fixture(),
      settings: {
        signing: { type: 'string', label: 'Signing key', secret: true, generated: true },
      },
      source: {
        provider: 'fixture',
        identity: 'account',
        verifyFunctionId: installId,
        syncFunctionIds: [syncId],
        eventTypeIds: [randomUUID()],
        revisionOrder: 'opaque',
      },
      functions: [
        fn(
          installId,
          'setup',
          { kind: 'install' },
          { type: 'object', additionalProperties: false },
        ),
        fn(
          syncId,
          'sync',
          { kind: 'job' },
          {
            type: 'object',
            properties: { sourceItemId: { type: 'string', maxLength: 36 } },
            required: ['sourceItemId'],
            additionalProperties: false,
          },
        ),
        fn(
          verifyId,
          'verify',
          { kind: 'route', route: 'notes' },
          { type: 'object', additionalProperties: false },
          5,
        ),
      ],
      webhooks: [
        {
          route: 'notes',
          verifierFunctionId: verifyId,
          syncFunctionId: syncId,
          secretSetting: 'signing',
          headers: ['webhook-id', 'webhook-timestamp', 'webhook-signature'],
        },
      ],
    };
    expect(defineExtension(valid).webhooks).toHaveLength(1);
    for (const change of [
      { verifierFunctionId: syncId },
      { syncFunctionId: installId },
      { secretSetting: 'notDeclared' },
      { accountHeader: 'provider-account' },
      { headers: ['authorization'] },
    ])
      expect(() =>
        defineExtension({ ...valid, webhooks: [{ ...valid.webhooks[0], ...change }] }),
      ).toThrow();
    expect(() =>
      defineExtension({ ...valid, webhooks: [valid.webhooks[0], valid.webhooks[0]] }),
    ).toThrow('webhook contract');
    expect(() =>
      defineExtension({
        ...valid,
        functions: valid.functions.map((value) =>
          value.universalId === verifyId ? { ...value, timeoutSeconds: 6 } : value,
        ),
      }),
    ).toThrow('webhook contract');
  });
  it('declares per-function secrets and scopes inside the release ceiling, defaulting to it when absent', () => {
    const fn = (extra: object) => ({
      universalId: randomUUID(),
      name: 'sync',
      description: 'Sync',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
      ...extra,
    });
    const settings = {
      apiKey: { type: 'string', label: 'API key', secret: true, required: true },
      signing: { type: 'string', label: 'Signing', secret: true, generated: true },
      enabled: { type: 'boolean', label: 'Enabled', required: true },
    };
    const manifest = defineExtension({
      ...fixture(),
      settings,
      functions: [fn({ secrets: ['apiKey'], scopes: ['read'] }), { ...fn({}), name: 'old' }],
    });
    const [narrow, legacy] = manifest.functions;
    if (!narrow || !legacy) throw new Error('missing functions');
    expect(functionSecrets(manifest, narrow)).toEqual(['apiKey']);
    expect(functionScopes(manifest, narrow)).toEqual(['read']);
    // An absent declaration keeps the first contract's behaviour (and digest).
    expect('secrets' in legacy).toBe(false);
    expect(functionSecrets(manifest, legacy)).toEqual(['apiKey', 'signing']);
    expect(functionScopes(manifest, legacy)).toEqual(['read', 'write']);
    for (const invalid of [
      { secrets: ['enabled'] },
      { secrets: ['missing'] },
      { secrets: ['apiKey', 'apiKey'] },
    ])
      expect(() => defineExtension({ ...fixture(), settings, functions: [fn(invalid)] })).toThrow(
        'function secrets',
      );
    for (const invalid of [{ scopes: ['read', 'read'] }, { scopes: [] }])
      expect(() => defineExtension({ ...fixture(), settings, functions: [fn(invalid)] })).toThrow();
    expect(() =>
      defineExtension({
        ...fixture(),
        scopes: ['read'],
        settings,
        functions: [fn({ scopes: ['read', 'write'] })],
      }),
    ).toThrow('function scopes');
  });
  it('gives install hooks the previously installed version, null on a first install', () => {
    expect(lifecycleInputSchema.parse({ previousVersion: null })).toEqual({
      previousVersion: null,
    });
    expect(lifecycleInputSchema.parse({ previousVersion: '1.2.3' })).toEqual({
      previousVersion: '1.2.3',
    });
    expect(lifecycleInputSchema.parse({})).toEqual({});
    expect(lifecycleInputSchema.safeParse({ previousVersion: 'x' }).success).toBe(false);
    expect(lifecycleInputSchema.safeParse({ other: 1 }).success).toBe(false);
  });
});
