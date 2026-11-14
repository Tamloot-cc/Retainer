import { describe, expect, it } from 'vitest';
import { defineExtension, functionUses, modelClient, releaseUses } from './index.js';
import { invocationSchema } from './protocol.js';

const fixture = () => ({
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

const fn = (
  universalId: string,
  name: string,
  extra: object = {},
  trigger: object = { kind: 'job' },
) => ({
  universalId,
  name,
  description: 'Model fixture',
  handlerDigest: 'b'.repeat(64),
  trigger,
  inputSchema: { type: 'object', additionalProperties: false },
  ...extra,
});

describe('uses in the manifest (model calls spec 3.1)', () => {
  it("declares model per function, and a release's uses are their union", () => {
    const manifest = defineExtension({
      ...fixture(),
      functions: [
        fn('0b6f6c50-9d1e-4b5d-8a3c-2f1e4d5c6b7a', 'pick', { uses: ['model'] }),
        fn('1c7f7d61-ae2f-4c6e-9b4d-3a2f5e6d7c8b', 'plain'),
      ],
    });
    expect(manifest.functions.map(functionUses)).toEqual([['model'], []]);
    expect(releaseUses(manifest)).toEqual(['model']);
    expect(releaseUses({ functions: [] })).toEqual([]);
  });

  it('refuses duplicates, unknown capabilities and webhook verifiers that use the model', () => {
    const with_ = (extra: object, trigger?: object) =>
      defineExtension({
        ...fixture(),
        functions: [fn('0b6f6c50-9d1e-4b5d-8a3c-2f1e4d5c6b7a', 'pick', extra, trigger)],
      });
    expect(() => with_({ uses: ['model', 'model'] })).toThrow();
    expect(() => with_({ uses: ['agent'] })).toThrow();
    expect(() => with_({ uses: [] })).toThrow();
    expect(() => with_({ uses: ['model'] }, { kind: 'route', route: 'hook' })).toThrow(
      'webhook verifiers cannot use platform capabilities',
    );
  });

  it('lets configure declare model', () => {
    const manifest = defineExtension({
      ...fixture(),
      functions: [
        fn(
          '0b6f6c50-9d1e-4b5d-8a3c-2f1e4d5c6b7a',
          'suggest',
          { uses: ['model'], scopes: ['read'] },
          { kind: 'configure' },
        ),
      ],
    });
    expect(releaseUses(manifest)).toEqual(['model']);
  });
});

describe('the invocation and modelClient (spec 3.2)', () => {
  const base = {
    protocolVersion: 1,
    runId: '0b6f6c50-9d1e-4b5d-8a3c-2f1e4d5c6b7a',
    attempt: 1,
    installationId: '1c7f7d61-ae2f-4c6e-9b4d-3a2f5e6d7c8b',
    releaseDigest: 'a'.repeat(64),
    functionId: '2d8a8e72-bf3a-4d7f-8c5e-4b3a6f7e8d9c',
    input: {},
    apiOrigin: 'https://retainer.test',
    runToken: 'rt_run_x',
    deadline: '2026-11-14T12:02:00.000Z',
  };

  it('accepts an optional model field and nothing else new', () => {
    expect(invocationSchema.parse(base).model).toBeUndefined();
    const model = { origin: 'https://model.test', token: 'rt_model_x' };
    expect(invocationSchema.parse({ ...base, model }).model).toEqual(model);
    expect(() => invocationSchema.parse({ ...base, modelOrigin: 'https://model.test' })).toThrow();
  });

  it('throws without the model field', () => {
    expect(() => modelClient(base)).toThrow("uses: ['model']");
  });

  it('points at the proxy with the model token and a timeout from the deadline', () => {
    const now = Date.parse('2026-11-14T12:00:00.000Z');
    const client = modelClient(
      { ...base, model: { origin: 'https://model.test/base', token: 'rt_model_x' } },
      () => now,
    );
    expect(client.baseURL).toBe('https://model.test/base');
    expect(client.apiKey).toBe('rt_model_x');
    expect(client.authToken).toBeNull();
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(2);
  });
});
