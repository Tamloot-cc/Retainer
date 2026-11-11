import { randomUUID } from 'node:crypto';
import { defineExtension, type ExtensionManifest } from '@retainer/extension';

export function extensionFixture(overrides: Partial<ExtensionManifest> = {}) {
  return defineExtension({
    manifestVersion: 1,
    universalId: randomUUID(),
    name: 'fixture',
    version: '1.0.0',
    description: 'Deterministic fixture',
    packageDigest: 'a'.repeat(64),
    serverVersions: ['0.1.0'],
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
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
}
