import { randomUUID } from 'node:crypto';
import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { compareVersions, holdReason, upgradeTargets } from './auto-upgrade.js';

const id = randomUUID();
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
    execution: 'standalone',
    requestedActor: 'agent',
    scopes: ['read'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},
    schema: [],
    views: [],
    functions: [],
    ...overrides,
  });
const base = {
  previous: manifest(),
  next: manifest({ version: '1.0.1' }),
  grantedActor: 'agent',
  grantedScopes: ['read'],
  schemaOperations: 0,
  viewActions: ['retain'],
  storedMapping: { outputs: {} },
  plannedMapping: { outputs: {} },
};

describe('compareVersions', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

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
  it('lets a version-only change through', () => {
    expect(holdReason(base)).toBeNull();
  });
  it('holds what an admin has to approve', () => {
    expect(holdReason({ ...base, previous: undefined })).toBe('previous_release_unavailable');
    expect(holdReason({ ...base, schemaOperations: 1 })).toBe('schema_changes');
    expect(holdReason({ ...base, viewActions: ['retain', 'create'] })).toBe('view_changes');
    expect(holdReason({ ...base, viewActions: ['update'] })).toBe('view_changes');
    expect(holdReason({ ...base, plannedMapping: { outputs: { a: { target: 'x' } } } })).toBe(
      'mapping_changes',
    );
    expect(holdReason({ ...base, next: manifest({ scopes: ['read', 'write'] }) })).toBe(
      'access_changes',
    );
    expect(holdReason({ ...base, next: manifest({ requestedActor: 'integration' }) })).toBe(
      'access_changes',
    );
    expect(
      holdReason({
        ...base,
        next: manifest({
          settings: {
            region: {
              type: 'string',
              label: 'Region',
              required: false,
              secret: false,
              reconnect: false,
            },
          },
        }),
      }),
    ).toBe('new_settings');
  });
  it('keeps a view the workspace edited or deleted without holding', () => {
    expect(
      holdReason({ ...base, viewActions: ['keep_workspace', 'deleted_workspace'] }),
    ).toBeNull();
  });
});
