import { defineExtension } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { ExtensionCatalog, hash, parseExtensionCatalog } from './catalog.js';

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
  it('resolves a reviewed server range across server patches and keeps exact-list digests', () => {
    const { serverVersions: _, ...base } = manifest();
    const ranged = { ...base, serverRange: '>=0.1.0 <0.2.0' };
    const outside = { ...base, version: '2.0.0', serverRange: '>=0.2.0 <0.3.0' };
    const catalog = new ExtensionCatalog([
      { manifest: ranged, actorCeiling: 'integration' },
      { manifest: outside, actorCeiling: 'integration' },
    ]);
    expect(catalog.list().map((r) => r.manifest.version)).toEqual(['1.0.0']);
    expect(catalog.get(ranged.universalId, '1.0.0').manifest.serverRange).toBe('>=0.1.0 <0.2.0');
    expect(() => catalog.get(outside.universalId, '2.0.0')).toThrow('support');
    // An already-built exact-list release keeps the digest it was installed with.
    const exact = manifest();
    const [listed] = new ExtensionCatalog([
      { manifest: exact, actorCeiling: 'integration' },
    ]).list();
    expect(listed?.digest).toBe(hash(exact));
    expect(listed?.manifest).not.toHaveProperty('serverRange');
  });
  it('hashes canonical JSON without key-order differences', () => {
    expect(hash({ a: 1, b: { d: 2, c: 3 } })).toBe(hash({ b: { c: 3, d: 2 }, a: 1 }));
  });
  it('pins the reviewed OAuth client into the release digest and across releases', () => {
    const initial = { ...manifest(), oauthClientId: 'registered-client' };
    expect(hash(initial)).not.toBe(hash(manifest()));
    expect(
      () =>
        new ExtensionCatalog([
          { manifest: initial, actorCeiling: 'integration' },
          {
            manifest: { ...initial, version: '2.0.0', oauthClientId: 'different-client' },
            actorCeiling: 'integration',
          },
        ]),
    ).toThrow('OAuth client');
    expect(
      parseExtensionCatalog(
        JSON.stringify([{ manifest: initial, actorCeiling: 'integration' }]),
      ).list()[0]?.manifest.oauthClientId,
    ).toBe('registered-client');
    expect(() => defineExtension({ ...initial, execution: 'hosted' })).toThrow();
    expect(() => defineExtension({ ...initial, oauthClientId: ' ' })).toThrow();
  });
});

it('keeps a registration connection mode immutable across releases', () => {
  const workspace = manifest();
  const member = defineExtension({
    ...workspace,
    version: '1.1.0',
    execution: 'hosted',
    connection: 'member',
    functions: [
      {
        universalId: 'b4adb12e-455a-4dd0-a793-1a2ec770a813',
        name: 'connect',
        description: 'Connect',
        handlerDigest: 'a'.repeat(64),
        trigger: { kind: 'connect' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  });
  expect(
    () =>
      new ExtensionCatalog(
        [workspace, member].map((manifest) => ({ manifest, actorCeiling: 'integration' })),
      ),
  ).toThrow('connection mode cannot change');
});
