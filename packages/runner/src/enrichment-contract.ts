import { defineExtension, type ExtensionManifest } from '@retainer/extension';
import { z } from 'zod';

/** Permanent identities of the company enrichment release (spec 4.1). */
export const ENRICHMENT = {
  registration: '9796c2c7-46f3-4006-8f35-059d5ef3553e',
  configure: 'a71658da-20db-4b37-9064-992ca0fd9fc0',
  backfill: '4768a194-e37e-4e93-af76-f145e2ae3d83',
  setup: 'c3376603-255e-4adb-819f-e3aa173f3ff9',
  enrich: 'ab556674-d905-4839-8516-7b1ee7455c80',
  employeeCountField: '509ddbdd-3b4e-45ec-b6b1-709255de3bdc',
  linkedinField: '4341a8ad-8c05-444e-98bb-3e357d5730a7',
  headquartersField: '770bf3de-d5df-48ac-95cb-16ec1c18c302',
} as const;
export const ENRICHMENT_FUNCTION_IDS: string[] = [
  ENRICHMENT.configure,
  ENRICHMENT.setup,
  ENRICHMENT.enrich,
  ENRICHMENT.backfill,
];

/** Exa's fixed API origin; no setting or input can change it. */
export const EXA_ORIGIN = 'https://api.exa.ai';

/**
 * The model enrichment calls, for mapping suggestions and for picking the
 * search result (model calls spec 6.6). Revisit it against the domain set
 * before changing it, including `claude-haiku-5-5`.
 */
export const ENRICHMENT_MODEL = 'claude-opus-5-5';

const text = (max: number) => z.string().max(max).nullable().optional();
/** The fields of Exa's `SearchCompanyEntityOutput` this adapter reads; all nullable. */
export const exaCompanyEntity = z.object({
  type: z.literal('company'),
  properties: z.object({
    name: text(500),
    workforce: z.object({ total: z.number().nullable() }).nullable().optional(),
    headquarters: z
      .object({ city: text(200), postalCode: text(40), country: text(200) })
      .nullable()
      .optional(),
  }),
});
export type ExaCompanyEntity = z.infer<typeof exaCompanyEntity>;
export const exaSearchResponse = z.object({
  results: z
    .array(
      z.object({
        url: z.string().max(2048),
        title: text(1000),
        text: z.string().max(100000).nullable().optional(),
        entities: z.array(z.unknown()).max(20).nullable().optional(),
      }),
    )
    .max(10),
});
export const exaTeam = z.object({ id: z.string().max(200) });

/**
 * The search for one company (model calls spec 6.3): its name and domain, or
 * the domain alone, across all domains, so a company whose site redirects or
 * whose profile lives under another domain is still found.
 */
export function exaSearchRequest(domain: string, name?: string | null) {
  const label = name?.trim().replace(/\s+/g, ' ').slice(0, 200);
  return {
    query: label ? `${label} ${domain}` : domain,
    type: 'auto',
    category: 'company',
    numResults: 5,
    contents: { text: { maxCharacters: 4000 } },
  };
}

export const ENRICHMENT_OUTPUTS = ['employee_count', 'linkedin_url', 'headquarters'] as const;
export type EnrichmentOutput = (typeof ENRICHMENT_OUTPUTS)[number];

/** How sure the model is of its pick (model calls spec 6.3). */
export const certaintySchema = z.enum(['high', 'medium', 'low']);
export type Certainty = z.infer<typeof certaintySchema>;

/** The reviewed mapping: the domain lookup and the outputs a workspace binds to fields. */
export const ENRICHMENT_OUTPUT_DEFINITIONS = [
  {
    key: 'employee_count',
    label: 'Employee count',
    description:
      "Employees Exa finds for the company, mostly from public profiles. Often lower than the company's own size band.",
    types: ['number' as const],
    field: {
      universalId: ENRICHMENT.employeeCountField,
      name: 'employeeCount',
      label: 'Employee Count',
      type: 'number' as const,
    },
  },
  {
    key: 'linkedin_url',
    label: 'LinkedIn URL',
    description: "The company's LinkedIn page, as listed in Exa's company profile.",
    types: ['links' as const],
    field: {
      universalId: ENRICHMENT.linkedinField,
      name: 'linkedinUrl',
      label: 'LinkedIn URL',
      type: 'links' as const,
    },
  },
  {
    key: 'headquarters',
    label: 'Headquarters',
    description: "The headquarters city, postcode and country in Exa's company data.",
    types: ['address' as const],
    field: {
      universalId: ENRICHMENT.headquartersField,
      name: 'headquarters',
      label: 'Headquarters',
      type: 'address' as const,
    },
  },
];

export function enrichmentManifest(build: {
  version?: string;
  packageDigest: string;
  handlerDigest: string;
  serverRange: string;
}): ExtensionManifest {
  const changeInput = {
    type: 'object',
    properties: { changePosition: { type: 'string', maxLength: 19 } },
    required: ['changePosition'],
    additionalProperties: false,
  };
  return defineExtension({
    manifestVersion: 1,
    universalId: ENRICHMENT.registration,
    name: 'company-enrichment',
    version: build.version ?? '1.0.0',
    description:
      'Fill in empty company details from Exa company search when a company gets a website domain or a new name. A model picks the right search result and suggests which fields to fill. Each workspace chooses the fields; values a person or agent set are never replaced.',
    packageDigest: build.packageDigest,
    serverRange: build.serverRange,
    runtimeVersion: 'node24',
    execution: 'hosted',
    protocolVersion: 1,
    requestedActor: 'agent',
    scopes: ['read', 'write'],
    connection: 'workspace',
    createPeople: 'never',
    onSourceDelete: 'keep',
    settings: {
      shareDomains: {
        type: 'boolean',
        label: 'Send company names and domains to Exa to look up company details',
        required: true,
        consent: true,
        default: false,
        reconnect: true,
        secret: false,
        description:
          "Only the company's name and website domain are sent, never other record data. Exa keeps queries unless Retainer’s Exa account has Zero Data Retention, which Exa offers on its Enterprise plan.",
      },
    },

    views: [],
    bindings: [
      {
        key: 'company',
        label: 'Companies',
        description: 'Look up companies by website and fill empty company details.',
        class: 'entity',
        access: 'write',
        required: true,
        fields: [
          {
            key: 'domain',
            label: 'Website',
            types: ['links'],
            required: true,
            lookup: true,
            create: {
              universalId: 'b142bbb7-233b-4312-8135-ac152f0fc9d6',
              name: 'domain',
              label: 'Website',
              type: 'links',
            },
          },
          {
            key: 'name',
            label: 'Name',
            types: ['text'],
            required: false,
            lookup: true,
            create: {
              universalId: 'ded82b59-487b-4a1a-9f07-1e07432ca707',
              name: 'name',
              label: 'Name',
              type: 'text',
            },
          },
          ...ENRICHMENT_OUTPUT_DEFINITIONS.map(({ field, ...output }) => ({
            ...output,
            required: false,
            create: field,
          })),
        ],
        create: {
          universalId: 'f386596a-181d-4695-b291-55e63872ea6c',
          nameSingular: 'company',
          namePlural: 'companies',
          labelSingular: 'Company',
          labelPlural: 'Companies',
          labelField: 'name',
          fields: [],
        },
      },
    ],
    functions: [
      {
        universalId: ENRICHMENT.configure,
        name: 'configure',
        description:
          'Check the provider connection and suggest company fields, using a model and a sample of companies.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 120,
        trigger: { kind: 'configure' },
        inputSchema: { type: 'object', additionalProperties: false },
        scopes: ['read'],
        uses: ['model'],
      },
      {
        universalId: ENRICHMENT.backfill,
        name: 'backfill',
        description: 'Fill newly mapped outputs on previously enriched companies, in pages.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 300,
        trigger: { kind: 'job' },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { cursor: { type: 'string', maxLength: 4096 } },
        },
        scopes: ['read', 'write'],
        mappedWrite: 'company',
        uses: ['model'],
      },
      {
        universalId: ENRICHMENT.setup,
        name: 'setup',
        description: 'Check the Exa connection.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 30,
        trigger: { kind: 'install' },
        inputSchema: { type: 'object', additionalProperties: false },
        scopes: ['read'],
      },
      {
        universalId: ENRICHMENT.enrich,
        name: 'enrich',
        description:
          'Look up a company by its name and domain when it is created or its name or domain changes, and fill its empty mapped fields.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 120,
        trigger: {
          kind: 'change',
          binding: 'company',
          fields: ['domain', 'name'],
          related: false,
          operations: ['create', 'update'],
        },
        inputSchema: changeInput,
        scopes: ['read', 'write'],
        mappedWrite: 'company',
        uses: ['model'],
      },
    ],
  });
}
