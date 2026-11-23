import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  defineExtension,
  defineFunction,
  defineTool,
  executionResultSchema,
  functionScopes,
  functionSecrets,
  lifecycleInputSchema,
  mergeBindingChoices,
  runsHostedCode,
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

  views: [],
  functions: [],
});
const sourceBindings = [
  {
    key: 'event',
    creates: true,
    label: 'Imported events',
    description: 'Test event destination',
    class: 'event',
    access: 'write',
    required: true,
    fields: [],
  },
];

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
      bindings: sourceBindings,
      functions: [
        {
          universalId: 'f3f3e359-61f7-4115-9dc9-63d9184c2070',
          name: 'watch',
          description: 'Watch fields',
          handlerDigest: 'b'.repeat(64),
          trigger: {
            kind: 'change',
            binding: 'event',
            fields: [],
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
      event: 'event',
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
    expect(
      defineExtension({ ...fixture(), source, bindings: sourceBindings, functions }).source
        ?.provider,
    ).toBe('fixture');
    expect(() =>
      defineExtension({
        ...fixture(),
        source,
        functions,
        bindings: sourceBindings.map((binding) => ({ ...binding, creates: undefined })),
      }),
    ).toThrow('event binding that creates records');
    expect(() =>
      defineExtension({
        ...fixture(),
        source,
        bindings: sourceBindings,
        functions: functions.slice(1),
      }),
    ).toThrow('source verification');
    expect(() =>
      defineExtension({
        ...fixture(),
        source,
        bindings: sourceBindings,
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
    expect(() => defineFunction({ ...fn, trigger: { kind: 'unknown' } })).toThrow();
    expect(() => defineFunction({ ...fn, timeoutSeconds: 301 })).toThrow();
    expect(() =>
      defineExtension({
        ...fixture(),
        settings: { key: { type: 'string', label: 'Key', secret: true, default: 'secret' } },
      }),
    ).toThrow();
  });
  it('normalizes tool declarations and validates their manifest contract', () => {
    const declaration = {
      universalId: randomUUID(),
      name: 'check_address',
      title: 'Check an address',
      description: 'Checks whether an address is deliverable.',
      handlerDigest: 'b'.repeat(64),
      effect: 'read',
      connection: 'workspace',
      inputSchema: {
        type: 'object',
        properties: { address: { type: 'string', description: 'Email address to check' } },
        required: ['address'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { deliverable: { type: 'boolean' } },
        required: ['deliverable'],
        additionalProperties: false,
      },
    };
    const tool = defineTool(declaration);
    expect(defineExtension({ ...fixture(), functions: [tool] }).functions).toEqual([tool]);
    expect(tool.trigger).toEqual({
      kind: 'tool',
      title: declaration.title,
      effect: declaration.effect,
      connection: declaration.connection,
      outputSchema: declaration.outputSchema,
    });
    expect(() => defineTool({ ...declaration, outputSchema: { type: 'object' } })).toThrow(
      'reject additional properties',
    );
    const memberTool = defineTool({ ...declaration, connection: 'member' });
    expect(() => defineExtension({ ...fixture(), functions: [memberTool] })).toThrow(
      'tool connection must match the release',
    );
    expect(() => defineFunction({ ...tool, trigger: { kind: 'job' } })).toThrow();
    // `then` would make the routine SDK's tools object look like a promise.
    expect(() => defineTool({ ...declaration, name: 'then' })).toThrow('cannot be named');
  });
  it('accepts bounded JSON output on successful protocol v1 results', () => {
    const result = { status: 'succeeded', output: { deliverable: false } };
    expect(executionResultSchema.parse(result)).toEqual(result);
    expect(executionResultSchema.parse({ status: 'succeeded' })).toEqual({ status: 'succeeded' });
    expect(executionResultSchema.safeParse({ ...result, status: 'retry' }).success).toBe(false);
    expect(executionResultSchema.safeParse({ ...result, output: 'é'.repeat(32768) }).success).toBe(
      false,
    );
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
      bindings: sourceBindings,
      settings: {
        signing: { type: 'string', label: 'Signing key', secret: true, generated: true },
      },
      source: {
        provider: 'fixture',
        identity: 'account',
        verifyFunctionId: installId,
        syncFunctionIds: [syncId],
        event: 'event',
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
  it('requires mapped writes to use a declared entity binding and a write function', () => {
    const fn = {
      universalId: randomUUID(),
      name: 'enrich',
      description: 'Enrich',
      handlerDigest: 'a'.repeat(64),
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
      mappedWrite: 'company',
    };
    const bindings = [
      {
        key: 'company',
        label: 'Companies',
        description: 'Company details',
        class: 'entity',
        access: 'write',
        required: true,
        fields: [],
      },
    ];
    expect(
      defineExtension({ ...fixture(), functions: [fn], bindings }).functions[0]?.mappedWrite,
    ).toBe('company');
    expect(() => defineExtension({ ...fixture(), functions: [fn] })).toThrow(
      'entity write binding',
    );
    expect(() =>
      defineExtension({ ...fixture(), functions: [{ ...fn, scopes: ['read'] }], bindings }),
    ).toThrow('runtime function with write');
    expect(() =>
      defineExtension({ ...fixture(), functions: [{ ...fn, mappedWrite: true }], bindings }),
    ).toThrow();
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

describe('member connection manifests', () => {
  const hook = (kind: 'connect' | 'disconnect' | 'install') => ({
    universalId: randomUUID(),
    name: kind,
    description: `${kind} lifecycle`,
    handlerDigest: 'b'.repeat(64),
    trigger: { kind },
    inputSchema: { type: 'object', additionalProperties: false },
  });
  const member = () => ({
    ...fixture(),
    connection: 'member',
    settings: {
      apiKey: { type: 'string', label: 'API key', secret: true, level: 'connection' },
      share: { type: 'boolean', label: 'Share', required: true, consent: true },
    },
    functions: [hook('connect')],
  });

  it('keeps workspace settings at the default level in the binding manifest', () => {
    const manifest = defineExtension(fixture());
    expect(manifest.settings.enabled).not.toHaveProperty('level');
    expect(createHash('sha256').update(JSON.stringify(manifest)).digest('hex')).toBe(
      '349b8a04f3cb432d0002dcf98c91fdf86ad3f7fbead0d61be67f58b5614db8d2',
    );
  });

  it('accepts per-member secrets and installer-approved sharing consent', () => {
    const manifest = defineExtension(member());
    expect(manifest.connection).toBe('member');
    expect(manifest.settings.apiKey?.level).toBe('connection');
    expect(manifest.settings.share).not.toHaveProperty('level');
    expect(manifest.functions[0]?.trigger.kind).toBe('connect');
  });

  it('requires exactly one connect hook and at most one disconnect hook', () => {
    for (const functions of [
      [],
      [hook('connect'), hook('connect')],
      [hook('connect'), hook('disconnect'), hook('disconnect')],
    ])
      expect(() => defineExtension({ ...member(), functions })).toThrow('one connect');
    expect(
      defineExtension({ ...member(), functions: [hook('connect'), hook('disconnect')] }).functions,
    ).toHaveLength(2);
  });

  it('rejects member settings and lifecycle hooks on workspace releases', () => {
    for (const change of [
      { settings: member().settings },
      { functions: [hook('connect')] },
      { functions: [hook('disconnect')] },
    ])
      expect(() => defineExtension({ ...fixture(), ...change })).toThrow('workspace releases');
  });

  it('requires hosted execution and rejects ownerless triggers and webhooks', () => {
    expect(() =>
      defineExtension({ ...member(), execution: 'standalone', functions: [] }),
    ).toThrow();
    for (const trigger of [
      { kind: 'route', route: 'callback' },
      { kind: 'serverRoute', route: 'callback' },
      { kind: 'change', binding: 'event', fields: [] },
    ])
      expect(() =>
        defineExtension({
          ...member(),
          bindings: sourceBindings,
          functions: [hook('connect'), { ...hook('install'), name: 'watch', trigger }],
        }),
      ).toThrow('change or route');
    expect(() =>
      defineExtension({
        ...member(),
        webhooks: [
          {
            route: 'callback',
            verifierFunctionId: randomUUID(),
            syncFunctionId: randomUUID(),
            secretSetting: 'apiKey',
            headers: ['webhook-id'],
          },
        ],
      }),
    ).toThrow('member webhooks');
  });

  it('requires secrets at connection level and sharing consent at installation level', () => {
    for (const level of [undefined, 'installation'])
      expect(() =>
        defineExtension({
          ...member(),
          settings: {
            apiKey: { type: 'string', label: 'Key', secret: true, ...(level ? { level } : {}) },
          },
        }),
      ).toThrow('connection level');
    expect(() =>
      defineExtension({
        ...member(),
        settings: {
          share: {
            type: 'boolean',
            label: 'Share',
            consent: true,
            required: true,
            level: 'connection',
          },
        },
      }),
    ).toThrow('installation level');
  });

  it('pins source verification to the connect hook and requires account identity', () => {
    const input = member();
    const syncId = randomUUID();
    const source = {
      provider: 'fixture',
      identity: 'account',
      verifyFunctionId: input.functions[0]?.universalId,
      syncFunctionIds: [syncId],
      event: 'event',
      revisionOrder: 'integer',
    };
    const sync = {
      ...hook('install'),
      universalId: syncId,
      name: 'sync',
      trigger: { kind: 'job' },
      inputSchema: {
        type: 'object',
        properties: { sourceItemId: { type: 'string', maxLength: 36 } },
        required: ['sourceItemId'],
        additionalProperties: false,
      },
    };
    const manifest = {
      ...input,
      source,
      bindings: sourceBindings,
      functions: [...input.functions, sync],
    };
    expect(defineExtension(manifest).source?.verifyFunctionId).toBe(
      input.functions[0]?.universalId,
    );
    expect(() =>
      defineExtension({ ...manifest, source: { ...source, identity: 'global-resource' } }),
    ).toThrow('account identity');
    expect(() =>
      defineExtension({ ...manifest, source: { ...source, verifyFunctionId: syncId } }),
    ).toThrow('connect function');
    const install = hook('install');
    expect(() =>
      defineExtension({
        ...manifest,
        functions: [...manifest.functions, install],
        source: { ...source, verifyFunctionId: install.universalId },
      }),
    ).toThrow('connect function');
  });

  it('disconnect hooks receive no implicit secrets and cannot request them', () => {
    const disconnect = hook('disconnect');
    const manifest = defineExtension({ ...member(), functions: [hook('connect'), disconnect] });
    const fn = manifest.functions.find((entry) => entry.trigger.kind === 'disconnect');
    if (!fn) throw new Error('disconnect missing');
    expect(functionSecrets(manifest, fn)).toEqual([]);
    expect(() =>
      defineExtension({
        ...member(),
        functions: [hook('connect'), { ...disconnect, secrets: ['apiKey'] }],
      }),
    ).toThrow('only generated connection secrets');
  });
});

describe('OAuth member connections', () => {
  const hook = (kind: 'connect' | 'disconnect', secrets?: string[]) => ({
    universalId: randomUUID(),
    name: kind,
    description: `${kind} lifecycle`,
    handlerDigest: 'b'.repeat(64),
    trigger: { kind },
    inputSchema: { type: 'object', additionalProperties: false },
    ...(secrets ? { secrets } : {}),
  });
  const generated = (label: string) => ({
    type: 'string',
    label,
    secret: true,
    generated: true,
    level: 'connection',
  });
  const oauth = () => ({
    ...fixture(),
    connection: 'member',
    settings: {
      apiKey: { type: 'string', label: 'API key', secret: true, level: 'connection' },
      verifier: generated('Verifier'),
      code: generated('Code'),
      tokens: generated('Tokens'),
    },
    functions: [
      hook('connect', ['apiKey', 'verifier', 'code', 'tokens']),
      hook('disconnect', ['tokens']),
    ],
    oauth: {
      verifierSetting: 'verifier',
      codeSetting: 'code',
      tokenSetting: 'tokens',
      keySetting: 'apiKey',
      revokeUrl: 'https://provider.example/settings/apps',
    },
    gettingStarted: { text: 'Nothing yet.', linkLabel: 'Open', url: 'https://provider.example' },
  });

  it('accepts an OAuth release whose disconnect hook reads the token secret', () => {
    const manifest = defineExtension(oauth());
    const fn = manifest.functions.find((entry) => entry.trigger.kind === 'disconnect');
    if (!fn) throw new Error('disconnect missing');
    expect(functionSecrets(manifest, fn)).toEqual(['tokens']);
    expect(manifest.oauth?.tokenSetting).toBe('tokens');
  });

  it('refuses links that are not https', () => {
    for (const url of ['http://provider.example', 'javascript:alert(1)', 'data:text/html,x']) {
      const revoke = oauth();
      expect(() =>
        defineExtension({ ...revoke, oauth: { ...revoke.oauth, revokeUrl: url } }),
      ).toThrow();
      const started = oauth();
      expect(() =>
        defineExtension({ ...started, gettingStarted: { ...started.gettingStarted, url } }),
      ).toThrow();
    }
  });

  it('requires a member connection', () => {
    const input = oauth();
    expect(() =>
      defineExtension({
        ...fixture(),
        oauth: input.oauth,
      }),
    ).toThrow('workspace releases');
    expect(() =>
      defineExtension({
        ...fixture(),
        gettingStarted: input.gettingStarted,
      }),
    ).toThrow('workspace releases');
  });

  it('requires three distinct generated connection secrets for the handshake', () => {
    const base = oauth();
    for (const change of [
      { codeSetting: 'verifier' },
      { tokenSetting: 'apiKey' },
      { verifierSetting: 'missing' },
    ])
      expect(() => defineExtension({ ...base, oauth: { ...base.oauth, ...change } })).toThrow(
        'three generated connection secrets',
      );
    expect(() =>
      defineExtension({
        ...base,
        settings: { ...base.settings, code: { ...generated('Code'), level: undefined } },
      }),
    ).toThrow();
  });

  it('requires the key setting to be a connection secret that is not generated', () => {
    const base = oauth();
    expect(() =>
      defineExtension({ ...base, oauth: { ...base.oauth, keySetting: 'tokens' } }),
    ).toThrow('key setting');
    expect(() =>
      defineExtension({ ...base, oauth: { ...base.oauth, keySetting: 'missing' } }),
    ).toThrow('key setting');
  });

  it('refuses required connection secrets with OAuth', () => {
    const base = oauth();
    expect(() =>
      defineExtension({
        ...base,
        settings: { ...base.settings, apiKey: { ...base.settings.apiKey, required: true } },
      }),
    ).toThrow('no connection secret may be required');
  });

  it('requires the connect hook to declare the handshake secrets', () => {
    const base = oauth();
    expect(() =>
      defineExtension({
        ...base,
        functions: [hook('connect', ['apiKey', 'tokens']), hook('disconnect', ['tokens'])],
      }),
    ).toThrow('connect hook must declare');
  });

  it('limits disconnect hooks to generated connection secrets', () => {
    const base = oauth();
    expect(() =>
      defineExtension({
        ...base,
        functions: [base.functions[0], hook('disconnect', ['apiKey'])],
      }),
    ).toThrow('only generated connection secrets');
  });
});

describe('configure contract', () => {
  const configure = () => ({
    universalId: randomUUID(),
    name: 'configure',
    description: 'Suggest settings',
    handlerDigest: 'b'.repeat(64),
    trigger: { kind: 'configure' },
    inputSchema: { type: 'object', additionalProperties: false },
    scopes: ['read'],
  });
  it('accepts exactly one explicitly read-only configure function', () => {
    expect(
      defineExtension({ ...fixture(), functions: [configure()] }).functions[0]?.trigger.kind,
    ).toBe('configure');
    for (const functions of [
      [configure(), configure()],
      [{ ...configure(), scopes: undefined }],
      [{ ...configure(), scopes: ['read', 'write'] }],
      [{ ...configure(), mappedWrite: 'company' }],
    ])
      expect(() => defineExtension({ ...fixture(), functions })).toThrow('configure');
    expect(() => defineExtension({ ...fixture(), settings: {}, functions: [configure()] })).toThrow(
      'configure',
    );
  });
});

describe('standalone apps (spec 8)', () => {
  const tool = (kind: string = 'tool') => ({
    universalId: randomUUID(),
    name: kind === 'tool' ? 'find_slots' : kind,
    description: 'Finds open times.',
    handlerDigest: 'b'.repeat(64),
    trigger:
      kind === 'tool'
        ? {
            kind,
            title: 'Find open times',
            effect: 'read',
            connection: 'workspace',
            outputSchema: { type: 'object', additionalProperties: false },
          }
        : { kind },
    inputSchema: { type: 'object', additionalProperties: false },
  });
  const standalone = (extra: Record<string, unknown> = {}) => ({
    ...fixture(),
    execution: 'standalone',
    oauthClientId: 'app-client',
    ...extra,
  });
  it('may declare tools and jobs, which run as hosted code', () => {
    const manifest = defineExtension(standalone({ functions: [tool(), tool('job')] }));
    expect(runsHostedCode(manifest)).toBe(true);
    expect(runsHostedCode(defineExtension(standalone()))).toBe(false);
    expect(runsHostedCode(defineExtension(fixture()))).toBe(true);
  });
  it('declares no function that needs a setup or cleanup job', () => {
    for (const kind of ['install', 'uninstall'])
      expect(() => defineExtension(standalone({ functions: [tool(kind)] }))).toThrow(
        'only tool and job',
      );
  });
  it('links from the sidebar only with an OAuth client and a plain path', () => {
    const link = { label: 'Planner', icon: 'calendar', path: '/start' };
    expect(defineExtension(standalone({ sidebarLink: link })).sidebarLink).toEqual(link);
    const { oauthClientId: _client, ...keyMode } = standalone();
    expect(() => defineExtension({ ...keyMode, sidebarLink: link })).toThrow('OAuth client');
    for (const path of ['start', '//evil.example/x', '/start?x=1', '/start#x', '/\\evil'])
      expect(() => defineExtension(standalone({ sidebarLink: { ...link, path } }))).toThrow();
    expect(() =>
      defineExtension(standalone({ sidebarLink: { ...link, icon: 'rocket' } })),
    ).toThrow();
  });
  it('requires the installation to contribute every installation-owned field', () => {
    const field = {
      key: 'orderId',
      label: 'Order ID',
      types: ['text'],
      required: true,
      installationOwned: true,
      owned: true,
      create: { universalId: randomUUID(), name: 'orderId', label: 'Order ID', type: 'text' },
    };
    const binding = {
      key: 'order',
      label: 'Orders',
      description: 'Tracks order IDs.',
      class: 'entity',
      access: 'write',
      required: true,
      fields: [field],
    };
    expect(
      defineExtension(standalone({ bindings: [binding] })).bindings?.[0]?.fields[0],
    ).toMatchObject({ installationOwned: true, owned: true });
    expect(() =>
      defineExtension(
        standalone({
          bindings: [{ ...binding, fields: [{ ...field, owned: undefined }] }],
        }),
      ),
    ).toThrow('invalid field order.orderId');
  });
});

it('merges proposed fields and values only when their target agrees', () => {
  const proposed = mergeBindingChoices(
    {
      task: {
        action: 'existing',
        objects: ['task'],
        fields: {
          title: { action: 'existing', field: 'title' },
          status: {
            action: 'existing',
            field: 'status',
            values: { open: 'todo', done: 'finished' },
          },
        },
      },
    },
    {
      task: {
        action: 'existing',
        objects: ['task'],
        fields: {
          status: { action: 'existing', field: 'status', values: { done: 'complete' } },
        },
      },
    },
  );
  expect(proposed.task).toEqual({
    action: 'existing',
    objects: ['task'],
    fields: {
      title: { action: 'existing', field: 'title' },
      status: { action: 'existing', field: 'status', values: { open: 'todo', done: 'complete' } },
    },
  });
  expect(
    mergeBindingChoices(proposed, {
      task: { action: 'existing', objects: ['action'] },
    }).task,
  ).toEqual({ action: 'existing', objects: ['action'] });
});
