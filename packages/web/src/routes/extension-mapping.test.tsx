import { RetainerApiError } from '@retainer/sdk';
import type { FieldView, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { compatibleFields, importDraft } from './extension-mapping.js';
import { ExtensionSettings, ExtensionsPage } from './extensions.js';

type Release = Awaited<ReturnType<typeof api.extensionCatalog>>['releases'][number];
type Installation = NonNullable<React.ComponentProps<typeof ExtensionSettings>['installation']>;
const COMPANY = '1f24f94d-6bc5-4955-b6ab-ac946e2b140a';

const field = (name: string, label: string, type: FieldView['type']): FieldView => ({
  name,
  label,
  type,
  description: null,
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'system',
  isProtected: false,
});
const company: ObjectView = {
  nameSingular: 'company',
  namePlural: 'companies',
  labelSingular: 'Company',
  labelPlural: 'Companies',
  description: null,
  labelField: 'name',
  owner: 'system',
  isProtected: true,
  class: 'entity',
  baseObject: 'company',
  fields: [
    field('name', 'Name', 'text'),
    { ...field('domain', 'Domain', 'links'), baseField: 'companyDomain' },
    field('profile', 'Profile', 'links'),
    field('teamSize', 'Team Size', 'number'),
    field('address', 'Address', 'address'),
  ],
};
const release: Release = {
  digest: 'a'.repeat(64),
  actorCeiling: 'agent',
  manifest: {
    manifestVersion: 1,
    universalId: 'b1d5f1c0-9a1e-4c55-8f53-2f1d3c1a9e01',
    name: 'Company Enrichment',
    version: '1.0.0',
    description: 'Fill in company details from Exa.',
    packageDigest: 'b'.repeat(64),
    serverVersions: ['0.1.0'],
    runtimeVersion: 'node24',
    protocolVersion: 1,
    execution: 'hosted',
    requestedActor: 'agent',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    schema: [],
    views: [],
    functions: [],
    settings: {},
    mapping: {
      objectId: COMPANY,
      lookup: { fieldId: 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641', type: 'links' },
      outputs: [
        {
          key: 'employee_count',
          label: 'Employee count',
          description: 'Employees Exa finds, mostly from public profiles.',
          types: ['number'],
          field: {
            universalId: '0dc97bea-8bbe-4bd8-9713-0c6628049268',
            name: 'employeeCount',
            label: 'Employee Count',
            type: 'number',
          },
        },
        {
          key: 'headquarters',
          label: 'Headquarters',
          description: 'Headquarters city and country.',
          types: ['address'],
        },
      ],
    },
  },
};
const mapping = release.manifest.mapping as NonNullable<Release['manifest']['mapping']>;
const preview: Awaited<ReturnType<typeof api.previewExtension>> = {
  planDigest: 'c'.repeat(64),
  schemaVersion: 1,
  generation: 0,
  releaseDigest: release.digest,
  operations: [],
  views: [],
  grants: { actor: 'agent', scopes: ['read', 'write'] },
  warnings: [],
  mapping: [
    {
      output: 'employee_count',
      action: 'create',
      field: { name: 'employeeCount', label: 'Employee Count', type: 'number' },
      contribution: true,
      status: 'ok',
    },
    {
      output: 'headquarters',
      action: 'existing',
      field: { name: 'address', label: 'Address', type: 'address' },
      contribution: false,
      status: 'ok',
    },
  ],
};
const installation: Installation = {
  id: 'installation',
  registrationId: release.manifest.universalId,
  version: '1.0.0',
  releaseDigest: release.digest,
  state: 'active',
  generation: 3,
  grantGeneration: 1,
  settingsRevision: 1,
  settings: {},
  secrets: {},
  grantedActor: 'agent',
  grantedScopes: ['read', 'write'],
  createdBy: { type: 'user', id: 'admin' },
};
function mount(element: React.ReactNode) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'admin' },
            scopes: ['admin'],
            workspace: { id: 'workspace' },
          } as Session,
          schema: { objects: [company] } as unknown as SchemaDescription,
        }}
      >
        {element}
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}
async function choose(output: string, option: string) {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${output} destination`) }));
  await userEvent.click(screen.getByRole('option', { name: option }));
}
afterEach(() => vi.restoreAllMocks());

describe('compatible fields', () => {
  it('never offers the field the extension looks companies up by', () => {
    const mapping = release.manifest.mapping;
    if (!mapping) throw new Error('fixture needs a mapping');
    const links = {
      key: 'linkedin_url',
      label: 'LinkedIn URL',
      description: 'The company LinkedIn page.',
      types: ['links' as const],
    };
    expect(compatibleFields(company, links, mapping.lookup).map((f) => f.name)).toEqual([
      'profile',
    ]);
    expect(compatibleFields(company, links).map((f) => f.name)).toEqual(['domain', 'profile']);
  });
});

describe('importDraft', () => {
  it('fills declared outputs and reports what the form cannot show', () => {
    const current = { employee_count: { action: 'create' as const } };
    const result = importDraft(
      JSON.stringify({
        employee_count: { action: 'existing', field: 'headcount' },
        headquarters: { action: 'existing', field: 'name' },
        revenue: { action: 'skip' },
      }),
      mapping,
      company,
      current,
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.choices).toEqual({
      employee_count: { action: 'existing', field: 'headcount' },
      headquarters: { action: 'existing', field: 'name' },
    });
    expect(result.issues).toEqual({
      employee_count: 'The draft names “headcount”, which does not exist here.',
      headquarters: 'The draft names “Name”, which cannot hold this value.',
      revenue: 'This extension has no such output.',
    });
  });
  it('refuses text that is not a mapping', () => {
    expect(importDraft('not json', mapping, company, {})).toEqual({
      error: 'The draft is not valid JSON.',
    });
    expect(
      'error' in importDraft('{"employee_count":{"action":"guess"}}', mapping, company, {}),
    ).toBe(true);
  });
});

describe('mapping review in the setup dialog', () => {
  it('offers compatible fields, sends the choices and shows the resolved bindings before approval', async () => {
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    const install = vi.spyOn(api, 'installExtension').mockResolvedValue(installation);
    mount(<ExtensionSettings release={release} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('Employees Exa finds, mostly from public profiles.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Employee count destination/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Team Size', 'Create “Employee Count”', 'Skip']);
    await userEvent.click(screen.getByRole('option', { name: 'Create “Employee Count”' }));
    await choose('Headquarters', 'Address');
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls[0]?.[0].mapping).toEqual({
      employee_count: { action: 'create' },
      headquarters: { action: 'existing', field: 'address' },
    });
    const bindings = await screen.findByRole('list', { name: 'Field mapping' });
    expect(within(bindings).getByText('Employee count → Employee Count')).toBeTruthy();
    expect(within(bindings).getByText('New field')).toBeTruthy();
    expect(within(bindings).getByText('Headquarters → Address')).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve installation' }));
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]?.[0].mapping).toEqual(plan.mock.calls[0]?.[0].mapping);
  });

  it('imports a draft into editable rows and keeps unknown fields visible', async () => {
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue(preview);
    mount(<ExtensionSettings release={release} onClose={() => {}} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Import a mapping draft' });
    fireEvent.change(within(dialog).getByLabelText('Draft'), {
      target: {
        value: JSON.stringify({
          employee_count: { action: 'existing', field: 'teamSize' },
          headquarters: { action: 'existing', field: 'office' },
        }),
      },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(screen.queryByRole('dialog', { name: 'Import a mapping draft' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Employee count destination/ }).textContent).toBe(
      'Team Size',
    );
    expect(screen.getByText('office (not available)')).toBeTruthy();
    expect(screen.getByText('The draft names “office”, which does not exist here.')).toBeTruthy();
    // Every row stays editable after an import.
    await choose('Headquarters', 'Skip');
    expect(screen.queryByText(/“office”/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls[0]?.[0].mapping).toEqual({
      employee_count: { action: 'existing', field: 'teamSize' },
      headquarters: { action: 'skip' },
    });
  });

  it('shows an invalid JSON draft without changing the rows', async () => {
    mount(<ExtensionSettings release={release} onClose={() => {}} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Import a mapping draft' });
    fireEvent.change(within(dialog).getByLabelText('Draft'), { target: { value: '{' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(within(dialog).getByText('The draft is not valid JSON.')).toBeTruthy();
  });

  it('puts server mapping errors next to the output they concern', async () => {
    vi.spyOn(api, 'previewExtension').mockRejectedValue(
      new RetainerApiError(422, 'mapping_invalid', 'the output mapping is not valid', {
        outputs: [{ output: 'employee_count', reason: 'duplicate_destination' }],
      }),
    );
    mount(<ExtensionSettings release={release} onClose={() => {}} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    expect(await screen.findByText('Another output already writes to that field.')).toBeTruthy();
  });
});

describe('approved mappings on an installation', () => {
  const view = {
    revision: 2,
    outputs: [
      {
        output: 'employee_count',
        action: 'existing' as const,
        field: { name: 'teamSize', label: 'Team Size', type: 'number' },
        contribution: false,
        status: 'ok' as const,
      },
      {
        output: 'headquarters',
        action: 'existing' as const,
        field: { name: 'office', label: 'Office', type: 'address' },
        contribution: false,
        status: 'missing' as const,
      },
    ],
  };
  it('shows a deleted target by its last label and opens the mapping editor', async () => {
    vi.spyOn(api, 'extensionCatalog').mockResolvedValue({ releases: [release] });
    vi.spyOn(api, 'extensions').mockResolvedValue({ installations: [installation] });
    vi.spyOn(api, 'extension').mockResolvedValue({
      ...installation,
      contributions: [],
      mapping: view,
    });
    mount(<ExtensionsPage />);
    const summary = await screen.findByRole('region', { name: 'Approved field mapping' });
    expect(within(summary).getByText('Headquarters → Office')).toBeTruthy();
    expect(within(summary).getByText('Field deleted')).toBeTruthy();
    expect(within(summary).getByText(/is not written until you remap or skip it/)).toBeTruthy();
    await userEvent.click(within(summary).getByRole('button', { name: 'Edit mapping' }));
    const dialog = await screen.findByRole('dialog', { name: 'Company Enrichment mapping' });
    expect(
      within(dialog).getByText('Changing the mapping does not fill in existing companies.'),
    ).toBeTruthy();
  });

  it('reviews a mapping change against the installed release and commits it on its own route', async () => {
    const plan = vi.spyOn(api, 'previewExtension').mockResolvedValue({ ...preview, generation: 3 });
    const change = vi
      .spyOn(api, 'changeExtensionMapping')
      .mockResolvedValue({ ...installation, generation: 4 });
    const settings = vi.spyOn(api, 'updateExtensionSettings');
    const onSaved = vi.fn();
    mount(
      <ExtensionSettings
        release={release}
        installation={installation}
        mappingView={view}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByRole('button', { name: /^Employee count destination/ }).textContent).toBe(
      'Team Size',
    );
    await choose('Headquarters', 'Address');
    await userEvent.click(screen.getByRole('button', { name: 'Review mapping' }));
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls[0]?.[0]).toMatchObject({
      installationId: installation.id,
      mappingChange: true,
      settings: {},
      mapping: {
        employee_count: { action: 'existing', field: 'teamSize' },
        headquarters: { action: 'existing', field: 'address' },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve mapping' }));
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    expect(change.mock.calls[0]?.[0]).toBe(installation.id);
    expect(settings).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });
});
