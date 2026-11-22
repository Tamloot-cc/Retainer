import { randomUUID } from 'node:crypto';
import {
  type BindingWriteStamp,
  defineExtension,
  type ExtensionBinding,
  type ExtensionBindingPlan,
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

export const testCompanyBinding: ExtensionBinding = {
  key: 'company',
  label: 'Companies',
  description: 'Company records submitted by the app.',
  class: 'entity',
  access: 'write',
  required: true,
  creates: true,
  fields: [
    { key: 'name', label: 'Name', types: ['text'], required: true },
    {
      key: 'externalKey',
      label: 'External key',
      types: ['text'],
      required: false,
      lookup: true,
      create: {
        universalId: randomUUID(),
        name: 'externalKey',
        label: 'External key',
        type: 'text',
        isUnique: true,
      },
    },
    {
      key: 'attachments',
      label: 'Attachments',
      types: ['files'],
      required: false,
      create: {
        universalId: randomUUID(),
        name: 'attachments',
        label: 'Attachments',
        type: 'files',
      },
    },
  ],
};

export function bindingStamp(plan: ExtensionBindingPlan, key: string): BindingWriteStamp {
  const binding = plan.bindings[key];
  const object = binding?.objects[0];
  if (!object || !binding) throw new Error(`Missing fixture binding ${key}`);
  return {
    bindings_revision: plan.bindings_revision,
    objectId: object.id,
    fieldIds: Object.fromEntries(
      Object.values(binding.fields).map((field) => [field.name, field.id]),
    ),
  };
}
