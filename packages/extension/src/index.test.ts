import { describe, expect, it } from 'vitest';
import { defineExtension, defineFunction } from './index.js';

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
        settings: { key: { type: 'string', label: 'Key', default: 'secret' } },
      }),
    ).toThrow();
  });
});
