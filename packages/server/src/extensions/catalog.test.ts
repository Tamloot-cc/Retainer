import { defineExtension } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { ExtensionCatalog, hash } from './catalog.js';

const manifest = () =>
  defineExtension({
    manifestVersion: 1,
    universalId: '8dbe12ac-96dd-438d-a6c9-b5ba3040c328',
    name: 'test',
    version: '1.0.0',
    description: 'Catalog fixture',
    packageDigest: 'a'.repeat(64),
    serverVersions: ['0.1.0'],
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'standalone',
    requestedActor: 'integration',
    scopes: ['read'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},
    schema: [],
    views: [],
    functions: [],
  });
describe('release-owned catalog', () => {
  it('does not allow manifest authority to exceed reviewed registration', () => {
    expect(() => new ExtensionCatalog([{ manifest: manifest(), actorCeiling: 'agent' }])).toThrow(
      'actor',
    );
  });
  it('rejects mutable same-version releases and cross-release actor changes', () => {
    const release = { manifest: manifest(), actorCeiling: 'integration' as const };
    expect(() => new ExtensionCatalog([release, release])).toThrow('mutable');
    expect(
      () =>
        new ExtensionCatalog([
          release,
          {
            manifest: { ...manifest(), version: '2.0.0', requestedActor: 'agent' },
            actorCeiling: 'agent',
          },
        ]),
    ).toThrow('ceiling');
  });
  it('isolates catalog data from input and output mutation', () => {
    const input = manifest();
    const catalog = new ExtensionCatalog([{ manifest: input, actorCeiling: 'integration' }]);
    input.scopes.push('write');
    const read = catalog.get(input.universalId, input.version);
    read.manifest.scopes.push('write');
    expect(catalog.get(input.universalId, input.version).manifest.scopes).toEqual(['read']);
  });
  it('omits incompatible releases and refuses explicit incompatible lookup', () => {
    const incompatible = { ...manifest(), serverVersions: ['999.0.0'] };
    const catalog = new ExtensionCatalog([{ manifest: incompatible, actorCeiling: 'integration' }]);
    expect(catalog.list()).toEqual([]);
    expect(() => catalog.get(incompatible.universalId, incompatible.version)).toThrow('support');
  });
  it('hashes canonical JSON without key-order differences', () => {
    expect(hash({ a: 1, b: { d: 2, c: 3 } })).toBe(hash({ b: { c: 3, d: 2 }, a: 1 }));
  });
});
