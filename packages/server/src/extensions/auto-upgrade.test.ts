import { randomUUID } from 'node:crypto';
import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { holdReason, upgradeTargets } from './auto-upgrade.js';

const id = randomUUID();
const fn = {
  universalId: randomUUID(),
  name: 'sync',
  description: 'Sync',
  handlerDigest: 'b'.repeat(64),
  trigger: { kind: 'job' as const },
  inputSchema: { type: 'object' as const, additionalProperties: false as const },
  timeoutSeconds: 120,
};
const manifest = (overrides: Partial<ExtensionManifest> = {}) =>
  defineExtension({
    manifestVersion: 1,
    universalId: id,
    name: 'fixture',
    version: '1.0.0',
    description: 'Fixture',
    packageDigest: 'a'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'agent',
    scopes: ['read'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},
    schema: [],
    views: [],
    functions: [fn],
    ...overrides,
  });
const base = {
  previous: manifest(),
  next: manifest({ version: '1.0.1' }),
  schemaOperations: 0,
  viewActions: ['retain'],
  storedMapping: { outputs: {} },
  plannedMapping: { outputs: {} },
};

describe('upgradeTargets', () => {
  const release = (version: string) => ({ manifest: manifest({ version }), digest: version });
  it('picks the newest release of each registration', () => {
    const targets = upgradeTargets(
      [release('1.0.9'), release('1.0.10'), release('1.0.2')],
      () => true,
    );
    expect(targets).toEqual([{ registrationId: id, version: '1.0.10', digest: '1.0.10' }]);
  });
  it('waits when the newest release is not runnable instead of choosing an older one', () => {
    const targets = upgradeTargets(
      [release('1.0.1'), release('1.0.2')],
      (r) => r.manifest.version !== '1.0.2',
    );
    expect(targets).toEqual([]);
  });
});

describe('holdReason', () => {
  it('holds a release that adds model use: more access for an admin to approve (model calls spec 3.1)', () => {
    expect(
      holdReason({
        ...base,
        next: manifest({ version: '1.0.1', functions: [{ ...fn, uses: ['model'] }] }),
      }),
    ).toBe('release_changes');
  });
  it('lets a version-only change through', () => {
    expect(holdReason(base)).toBeNull();
  });
  it('lets a code-only change through', () => {
    const next = manifest({
      version: '1.0.1',
      packageDigest: 'c'.repeat(64),
      functions: [{ ...fn, handlerDigest: 'd'.repeat(64) }],
    });
    expect(holdReason({ ...base, next })).toBeNull();
  });
  it('holds any change to the release contract', () => {
    const changed: Partial<ExtensionManifest>[] = [
      { scopes: ['read', 'write'] },
      { requestedActor: 'integration' },
      { createPeople: 'everyone' },
      {
        settings: {
          region: {
            type: 'string',
            label: 'Region',
            required: false,
            secret: false,
            reconnect: false,
          },
        },
      },
      { functions: [fn, { ...fn, universalId: randomUUID(), name: 'other' }] },
    ];
    for (const overrides of changed)
      expect(holdReason({ ...base, next: manifest({ version: '1.0.1', ...overrides }) })).toBe(
        'release_changes',
      );
  });
  it('holds work the plan finds even when the contract is the same', () => {
    expect(holdReason({ ...base, previous: undefined })).toBe('previous_release_unavailable');
    expect(holdReason({ ...base, schemaOperations: 1 })).toBe('schema_changes');
    expect(holdReason({ ...base, viewActions: ['retain', 'create'] })).toBe('view_changes');
    expect(holdReason({ ...base, viewActions: ['update'] })).toBe('view_changes');
    expect(holdReason({ ...base, plannedMapping: { outputs: { a: { target: 'x' } } } })).toBe(
      'mapping_changes',
    );
  });
  it('keeps a view the workspace edited or deleted without holding', () => {
    expect(
      holdReason({ ...base, viewActions: ['keep_workspace', 'deleted_workspace'] }),
    ).toBeNull();
  });
});
