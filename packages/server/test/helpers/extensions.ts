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
      description: field.description,
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
    {
      description: 'Fixture description.',
      key: 'name',
      label: 'Name',
      types: ['text'],
      required: true,
    },
    {
      description: 'Fixture description.',
      key: 'externalKey',
      label: 'External key',
      types: ['text'],
      required: false,
      lookup: true,
      create: {
        description: 'Fixture description.',
        universalId: randomUUID(),
        name: 'externalKey',
        label: 'External key',
        type: 'text',
        isUnique: true,
      },
    },
    {
      description: 'Fixture description.',
      key: 'attachments',
      label: 'Attachments',
      types: ['files'],
      required: false,
      create: {
        description: 'Fixture description.',
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

type Requester = {
  request: (
    path: string,
    options: { key?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any }>;
};

/**
 * Installs a release that has a `configure` function, in its two steps
 * (configure spec 4): approve access, which queues `configure`, then review
 * the bindings and turn it on. Returns the turned-on installation.
 */
export async function installReviewed(
  app: Requester,
  key: string,
  input: { bindings?: unknown; [field: string]: unknown },
) {
  const { bindings: _bindings, ...access } = input;
  const accessPreview = await app.request('/v1/extensions/preview', { key, body: access });
  if (accessPreview.status !== 200) throw new Error(JSON.stringify(accessPreview.body));
  const configuring = await app.request('/v1/extensions', {
    key,
    body: { ...access, planDigest: accessPreview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  if (configuring.status !== 201) throw new Error(JSON.stringify(configuring.body));
  const final = { ...input, installationId: configuring.body.id, turnOn: true };
  const preview = await app.request('/v1/extensions/preview', { key, body: final });
  if (preview.status !== 200) throw new Error(JSON.stringify(preview.body));
  const installed = await app.request(`/v1/extensions/${configuring.body.id}/turn-on`, {
    key,
    body: { ...final, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  if (installed.status !== 200) throw new Error(JSON.stringify(installed.body));
  return installed.body as { id: string; [field: string]: unknown };
}
