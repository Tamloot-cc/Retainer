import { randomUUID } from 'node:crypto';
import {
  defineExtension,
  type ExtensionBinding,
  type ExtensionManifest,
} from '@retainer/extension';

export function extensionFixture(overrides: Partial<ExtensionManifest> = {}) {
  return defineExtension({
    manifestVersion: 1,
    universalId: randomUUID(),
    name: 'fixture',
    version: '1.0.0',
    description: 'Deterministic fixture',
    packageDigest: 'a'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'integration',
    scopes: ['read'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {},

    views: [],
    functions: [],
    ...overrides,
  });
}

type NewObject = NonNullable<ExtensionBinding['create']>;
type NewField = NonNullable<ExtensionBinding['fields'][number]['create']>;

export function ownedTestFields(key: string, label: string, fields: NewField[]): ExtensionBinding {
  return {
    key,
    label,
    description: 'Schema for the test extension.',
    class: 'entity',
    access: 'write',
    required: true,
    fields: fields.map((field) => ({
      key: field.name,
      label: field.label,
      types: [field.type],
      required: true,
      owned: true,
      create: field,
    })),
  };
}

export function ownedTestObject(object: NewObject): ExtensionBinding {
  return {
    ...ownedTestFields(object.nameSingular, object.labelPlural, object.fields),
    owned: true,
    create: { ...object, fields: [] },
  };
}
