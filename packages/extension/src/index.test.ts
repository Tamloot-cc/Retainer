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
