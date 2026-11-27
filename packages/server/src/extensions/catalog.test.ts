import { defineExtension } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../version.js';
import { ExtensionCatalog, hash, parseExtensionCatalog } from './catalog.js';

const manifest = () =>
  defineExtension({
    manifestVersion: 1,
    universalId: '8dbe12ac-96dd-438d-a6c9-b5ba3040c328',
    name: 'test',
    version: '1.0.0',
    description: 'Catalog fixture',
    packageDigest: 'a'.repeat(64),
    serverVersions: [VERSION],
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'standalone',
    requestedActor: 'integration',
    scopes: ['read'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},

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
  it('holds the newest release to required descriptions and loads older ones as published', () => {
    const binding = {
      key: 'order',
      label: 'Orders',
      description: 'Orders tracked by the app.',
      class: 'entity' as const,
      access: 'read' as const,
      required: true,
      fields: [{ key: 'orderId', label: 'Order ID', types: ['text' as const], required: true }],
    };
    const older = { ...manifest(), bindings: [binding] };
    const newer = {
      ...older,
      version: '1.1.0',
      bindings: [
        { ...binding, fields: [{ ...binding.fields[0], description: "The order's ID." }] },
      ],
    };
    const load = (...releases: object[]) =>
      parseExtensionCatalog(
        JSON.stringify(
          releases.map((release) => ({ manifest: release, actorCeiling: 'integration' })),
        ),
      ).list();
    const listed = load(older, newer).find((release) => release.manifest.version === '1.0.0');
    expect(listed?.digest).toBe(hash(older));
    expect(listed?.manifest.bindings?.[0]?.fields[0]).not.toHaveProperty('description');
    expect(() => load(older)).toThrow('describe orderId in binding order');
    // A higher release this server can't run leaves the older one the newest offered.
    const { serverVersions: _, ...unversioned } = newer;
    const incompatible = { ...unversioned, version: '2.0.0', serverRange: '>=99.0.0 <100.0.0' };
    expect(() => load(older, incompatible)).toThrow('describe orderId in binding order');
  });
  it("finds a run's release by digest, and answers a release it lacks with a retryable 503", () => {
    const m = manifest();
    const catalog = new ExtensionCatalog([{ manifest: m, actorCeiling: 'integration' }]);
    const digest = catalog.list()[0]?.digest as string;
    expect(catalog.forRun({ registrationId: m.universalId, releaseDigest: digest }).digest).toBe(
      digest,
    );
    for (const run of [
      { registrationId: m.universalId, releaseDigest: 'f'.repeat(64) },
      { registrationId: '0f3c7a39-5d7e-4f3e-9a51-2b6f1d2c8e70', releaseDigest: digest },
    ])
      expect(() => catalog.forRun(run)).toThrow(
        expect.objectContaining({ status: 503, code: 'release_not_loaded' }),
      );
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
  it('refuses two registrations that pin the same OAuth client', () => {
    const initial = { ...manifest(), oauthClientId: 'registered-client' };
    expect(
      () =>
        new ExtensionCatalog([
          { manifest: initial, actorCeiling: 'integration' },
          {
            manifest: { ...initial, universalId: '0c6f2b8e-3d55-4a4f-9a3e-7b1d2c4e5f60' },
            actorCeiling: 'integration',
          },
        ]),
    ).toThrow('an OAuth client belongs to one registration');
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

describe('standalone releases with functions (extensions spec 8)', () => {
  const withTool = () =>
    defineExtension({
      ...manifest(),
      functions: [
        {
          universalId: '2f0f4a3e-7f5e-4c1b-9a51-2c8f2f7f9d10',
          name: 'find_slots',
          description: 'Finds open times.',
          handlerDigest: 'b'.repeat(64),
          trigger: {
            kind: 'tool',
            title: 'Find open times',
            effect: 'read',
            connection: 'workspace',
            outputSchema: { type: 'object', additionalProperties: false },
          },
          inputSchema: { type: 'object', additionalProperties: false },
        },
      ],
    });
  it('runs only where the catalog enables hosted execution, like a hosted release', () => {
    const disabled = new ExtensionCatalog([{ manifest: withTool(), actorCeiling: 'integration' }]);
    expect(() => disabled.runtime.resolve(withTool().universalId, '1.0.0')).toThrow(
      'hosted execution',
    );
    const enabled = new ExtensionCatalog([
      { manifest: withTool(), actorCeiling: 'integration', runtimeEnabled: true },
    ]);
    expect(enabled.runtime.resolve(withTool().universalId, '1.0.0').functions).toHaveLength(1);
    // Without functions, a standalone app runs nothing here and needs no flag.
    const plain = new ExtensionCatalog([{ manifest: manifest(), actorCeiling: 'integration' }]);
    expect(plain.runtime.resolve(manifest().universalId, '1.0.0').execution).toBe('standalone');
  });
});
