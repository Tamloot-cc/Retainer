import {
  defineExtension,
  type ExtensionBinding,
  type ExtensionManifest,
  recordButtonInputSchema,
} from '@retainer/extension';
import type { FieldType } from '@retainer/shared';
import { z } from 'zod';

/** Permanent identities of the enrichment release (spec 4.1). */
export const ENRICHMENT = {
  registration: '9796c2c7-46f3-4006-8f35-059d5ef3553e',
  configure: 'a71658da-20db-4b37-9064-992ca0fd9fc0',
  backfill: '4768a194-e37e-4e93-af76-f145e2ae3d83',
  setup: 'c3376603-255e-4adb-819f-e3aa173f3ff9',
  enrich: 'ab556674-d905-4839-8516-7b1ee7455c80',
  enrichPerson: '3edcca1a-6179-4e23-b387-328d7f7c2a88',
  backfillPerson: '6d72dd76-5c7d-462e-99b2-9f275898a47b',
  enrichCompanyNow: 'f2a76368-d95d-4020-a8e9-099b1e5ceda4',
  enrichPersonNow: 'd8c01ffc-4418-43e8-a084-dc7d499d8117',
  employeeCountField: '509ddbdd-3b4e-45ec-b6b1-709255de3bdc',
  linkedinField: '4341a8ad-8c05-444e-98bb-3e357d5730a7',
  headquartersField: '770bf3de-d5df-48ac-95cb-16ec1c18c302',
  descriptionField: '0d383c6c-ed85-4737-ae5f-10d4b591ffdb',
  industryField: '57ba2bcc-5124-4064-9671-8055c93f4622',
  foundedYearField: 'ebd2313c-7ce9-47f6-b6d7-c3b8ada9c493',
  annualRevenueField: '1e3a7523-915a-4d96-b51c-17d4317943c9',
  totalFundingField: '27d56c42-b8e1-40ae-b265-75a1b0344208',
  lastRoundField: 'd1794bf4-418f-46f9-bfa6-d5638dbbf77c',
  lastRoundDateField: 'fb33cee9-bfd1-4a5a-9a7d-b7c3e99f4c6a',
  lastRoundAmountField: 'f4b84585-3df5-4180-bc34-9a46b14f5e07',
  monthlyVisitsField: 'd6db6a7f-10f2-415f-b536-5b873f0306c0',
  personObject: '5280b14d-3c92-4376-a2eb-1e58d539404b',
  personNameField: '377ecb56-bff6-4238-a5ac-e08a86576da7',
  personEmailsField: '43f1fd6e-59f8-4ae6-a67c-73d09b3b1aad',
  personLinkedinField: '940ab8d5-0072-45f8-983d-2e43bbc8315f',
  jobTitleField: '35702180-1c96-4766-999e-d33b4dec385c',
  headlineField: '023b9808-611b-4c09-9aef-27702af16a75',
  locationField: '10a6d4d8-1e32-47e5-9aa6-f1d55443d359',
  seniorityField: '9488032e-1bdb-4bd2-8167-d03bfff4cb1c',
  departmentField: 'bf93eb48-4911-411b-bbe9-ac55c32b26a7',
} as const;
export const ENRICHMENT_FUNCTION_IDS: string[] = [
  ENRICHMENT.configure,
  ENRICHMENT.setup,
  ENRICHMENT.enrich,
  ENRICHMENT.backfill,
  ENRICHMENT.enrichPerson,
  ENRICHMENT.backfillPerson,
  ENRICHMENT.enrichCompanyNow,
  ENRICHMENT.enrichPersonNow,
];

/** Exa's fixed API origin; no setting or input can change it. */
export const EXA_ORIGIN = 'https://api.exa.ai';

/**
 * The model enrichment calls, for mapping suggestions and for picking the
 * search result (model calls spec 6.6, 6.7).
 */
export const ENRICHMENT_MODEL = 'claude-haiku-5-5';

const text = (max: number) => z.string().max(max).nullable().optional();
/** A property this adapter can do without: a malformed one reads as null instead of dropping the result. */
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(null);
const amount = optional(z.number());
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
    foundedYear: amount,
    description: optional(z.string()),
    financials: optional(
      z.object({
        revenueAnnual: amount,
        fundingTotal: amount,
        fundingLatestRound: optional(
          z.object({ name: optional(z.string()), date: optional(z.string()), amount }),
        ),
      }),
    ),
    webTraffic: optional(z.object({ visitsMonthly: amount })),
  }),
});
/** The fields of Exa's `SearchPersonEntityOutput` this adapter reads; all nullable. */
export const exaPersonEntity = z.object({
  type: z.literal('person'),
  properties: z.object({
    name: text(500),
    location: optional(z.string().max(500)),
    workHistory: optional(
      z
        .array(
          z.object({
            title: optional(z.string().max(500)),
            dates: optional(z.object({ from: optional(z.string()), to: optional(z.string()) })),
            company: optional(z.object({ name: optional(z.string().max(500)) })),
          }),
        )
        .max(500),
    ),
  }),
});
const exaResult = z.object({
  url: z.string().max(2048),
  title: text(1000),
  text: z.string().max(100000).nullable().optional(),
  entities: z.array(z.unknown()).max(20).nullable().optional(),
});
export const exaSearchResponse = z.object({ results: z.array(exaResult).max(10) });
export const exaTeam = z.object({ id: z.string().max(200) });

/** A query part: whitespace collapsed, at most `max` characters. */
const part = (value: string | null | undefined, max: number) =>
  value?.trim().replace(/\s+/g, ' ').slice(0, max) ?? '';
const search = (
  category: 'company' | 'people',
  parts: (string | null | undefined)[],
  { partChars = 200, queryChars = Infinity, textChars = 4000 } = {},
) => ({
  query: parts
    .map((value) => part(value, partChars))
    .filter(Boolean)
    // Whole parts only, while they fit.
    .reduce((query, next) => {
      const joined = query ? `${query} ${next}` : next;
      return joined.length <= queryChars ? joined : query;
    }, ''),
  type: 'auto',
  category,
  numResults: 5,
  contents: { text: { maxCharacters: textChars } },
});

/**
 * The search for one company (model calls spec 6.3): its name and domain, or
 * the domain alone, across all domains, so a company whose site redirects or
 * whose profile lives under another domain is still found.
 */
export const exaSearchRequest = (domain: string | null, name?: string | null) =>
  search('company', [name, domain]);

/**
 * One people search (enrichment spec 7.3): the given parts, each cut at 500
 * characters, joined whole up to 1,000 characters, with 6,000 characters of profile text for the model to
 * compare. The lookup sends two: the person's name with the rest of their
 * record, email address included, and their name alone.
 */
export const exaPeopleRequest = (parts: (string | null | undefined)[]) =>
  search('people', parts, { partChars: 500, queryChars: 1000, textChars: 6000 });

/** One LinkedIn profile read directly (enrichment spec 7.3, step 1). */
export function exaProfileRequest(url: string) {
  return { urls: [url], text: { maxCharacters: 4000 } };
}

/** How sure the model is of its pick (model calls spec 6.3). */
export const certaintySchema = z.enum(['high', 'medium', 'low']);
export type Certainty = z.infer<typeof certaintySchema>;

type OutputDefinition = {
  key: string;
  label: string;
  description: string;
  types: [FieldType];
  field: {
    universalId: string;
    name: string;
    label: string;
    type: FieldType;
    description: string;
  };
};
const output = (
  key: string,
  label: string,
  type: FieldType,
  universalId: string,
  name: string,
  description: string,
): OutputDefinition => ({
  key,
  label,
  description,
  types: [type],
  field: { universalId, name, label, type, description },
});

/** What enrichment can write to a company, in the order an admin reviews them. */
export const COMPANY_OUTPUTS = [
  output(
    'employee_count',
    'Employee count',
    'number',
    ENRICHMENT.employeeCountField,
    'employeeCount',
    "Employees Exa finds for the company, mostly from public profiles. Often lower than the company's own size band.",
  ),
  output(
    'linkedin_url',
    'LinkedIn URL',
    'links',
    ENRICHMENT.linkedinField,
    'linkedinUrl',
    "The company's LinkedIn page, as listed in Exa's company profile.",
  ),
  output(
    'headquarters',
    'Headquarters',
    'address',
    ENRICHMENT.headquartersField,
    'headquarters',
    "The headquarters city, postcode and country in Exa's company data.",
  ),
  output(
    'description',
    'Description',
    'text',
    ENRICHMENT.descriptionField,
    'description',
    'What the company says it does, from its public profile. Up to 2,000 characters.',
  ),
  output(
    'industry',
    'Industry',
    'text',
    ENRICHMENT.industryField,
    'industry',
    "The company's industry as its public profile lists it, such as Software Development.",
  ),
  output(
    'founded_year',
    'Founded year',
    'number',
    ENRICHMENT.foundedYearField,
    'foundedYear',
    'The year the company was founded.',
  ),
  output(
    'annual_revenue',
    'Annual revenue',
    'money',
    ENRICHMENT.annualRevenueField,
    'annualRevenue',
    "Exa's estimate of annual revenue in US dollars. Mostly available for larger companies, rarely for startups.",
  ),
  output(
    'total_funding',
    'Total funding',
    'money',
    ENRICHMENT.totalFundingField,
    'totalFunding',
    'Total funding raised in US dollars, from public funding data. May lag a recent round.',
  ),
  output(
    'last_funding_round',
    'Last funding round',
    'text',
    ENRICHMENT.lastRoundField,
    'lastFundingRound',
    'The name of the latest funding round Exa knows, such as Series A. May lag a recent announcement.',
  ),
  output(
    'last_funding_date',
    'Last funding date',
    'date',
    ENRICHMENT.lastRoundDateField,
    'lastFundingDate',
    'The date of the latest funding round Exa knows.',
  ),
  output(
    'last_funding_amount',
    'Last funding amount',
    'money',
    ENRICHMENT.lastRoundAmountField,
    'lastFundingAmount',
    'The amount of the latest funding round Exa knows, in US dollars.',
  ),
  output(
    'monthly_web_visits',
    'Monthly web visits',
    'number',
    ENRICHMENT.monthlyVisitsField,
    'monthlyWebVisits',
    "Estimated visits to the company's website in the latest month.",
  ),
];

/** What enrichment can write to a person, in the order an admin reviews them. */
export const PERSON_OUTPUTS = [
  output(
    'job_title',
    'Job title',
    'text',
    ENRICHMENT.jobTitleField,
    'jobTitle',
    "The person's current title at their company, such as Head of Design.",
  ),
  output(
    'headline',
    'Headline',
    'text',
    ENRICHMENT.headlineField,
    'headline',
    "The one-line headline of the person's public profile.",
  ),
  output(
    'location',
    'Location',
    'text',
    ENRICHMENT.locationField,
    'location',
    'Where the person is based, such as San Francisco, California, United States.',
  ),
  output(
    'seniority',
    'Seniority',
    'text',
    ENRICHMENT.seniorityField,
    'seniority',
    "The level of the person's current role, such as Founder, C-Level or Senior.",
  ),
  output(
    'department',
    'Department',
    'text',
    ENRICHMENT.departmentField,
    'department',
    "The department of the person's current role, such as Engineering and Technical. Founders are often listed under Consulting.",
  ),
  output(
    'linkedin_url',
    'LinkedIn URL',
    'links',
    ENRICHMENT.personLinkedinField,
    'linkedinUrl',
    "The person's LinkedIn profile. When it is already set, enrichment reads that profile instead of searching.",
  ),
];

/** The outputs of each binding enrichment writes to. */
export const OUTPUTS_BY_BINDING = { company: COMPANY_OUTPUTS, person: PERSON_OUTPUTS } as const;
export type EnrichmentBindingKey = keyof typeof OUTPUTS_BY_BINDING;

const outputFields = (outputs: OutputDefinition[]) =>
  outputs.map(({ field, ...rest }) => ({ ...rest, required: false, create: field }));

/** Where enrichment reads and writes, reviewed per workspace. */
export const ENRICHMENT_BINDINGS: ExtensionBinding[] = [
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
        description: "The company's website, the main way to look the company up.",
        types: ['links'],
        required: true,
        lookup: true,
        create: {
          universalId: 'b142bbb7-233b-4312-8135-ac152f0fc9d6',
          name: 'domain',
          label: 'Website',
          type: 'links',
          description: "The company's website.",
        },
      },
      {
        key: 'name',
        label: 'Name',
        description: "The company's name, used with the website to find the right company.",
        types: ['text'],
        required: false,
        lookup: true,
        create: {
          universalId: 'ded82b59-487b-4a1a-9f07-1e07432ca707',
          name: 'name',
          label: 'Name',
          type: 'text',
          description: "The company's name.",
        },
      },
      ...outputFields(COMPANY_OUTPUTS),
    ],
    create: {
      universalId: 'f386596a-181d-4695-b291-55e63872ea6c',
      nameSingular: 'company',
      namePlural: 'companies',
      labelSingular: 'Company',
      labelPlural: 'Companies',
      description: 'Companies the workspace works with.',
      labelField: 'name',
      fields: [],
    },
  },
  {
    key: 'person',
    label: 'People',
    description:
      "Look up people by their LinkedIn profile, or by name and their company, and fill empty details. Skip it to keep people's names away from Exa.",
    class: 'entity',
    access: 'write',
    required: false,
    fields: [
      // The first lookup field: the mapped write checks it is unchanged.
      {
        key: 'email',
        label: 'Email',
        description:
          'The person’s email address, sent to Exa and the model with the rest of their record. A work email’s domain also tells which company they work at.',
        types: ['emails'],
        required: false,
        lookup: true,
        create: {
          universalId: ENRICHMENT.personEmailsField,
          name: 'emails',
          label: 'Emails',
          type: 'emails',
          description: "The person's email addresses.",
        },
      },
      {
        key: 'name',
        label: 'Name',
        description: "The person's full name, used with their company to find their profile.",
        types: ['full_name', 'text'],
        required: true,
        lookup: true,
        create: {
          universalId: ENRICHMENT.personNameField,
          name: 'name',
          label: 'Name',
          type: 'full_name',
          description: "The person's full name.",
        },
      },
      {
        key: 'company',
        label: 'Company',
        description: "The person's company, whose name and website help find the right person.",
        types: ['relation'],
        required: false,
        lookup: true,
        target: 'company',
      },
      ...outputFields(PERSON_OUTPUTS),
    ],
    create: {
      universalId: ENRICHMENT.personObject,
      nameSingular: 'person',
      namePlural: 'people',
      labelSingular: 'Person',
      labelPlural: 'People',
      description: 'People the workspace works with.',
      labelField: 'name',
      fields: [],
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
  const pageInput = {
    type: 'object',
    additionalProperties: false,
    properties: { cursor: { type: 'string', maxLength: 4096 } },
  };
  return defineExtension({
    manifestVersion: 1,
    universalId: ENRICHMENT.registration,
    name: 'exa-enrichment',
    version: build.version ?? '2.0.0',
    description:
      'Fill in empty company and people details from Exa. Companies are looked up by website and name; people by their LinkedIn profile, or by name and the rest of their record. A model picks the right search result and suggests where each detail goes. Each workspace chooses the fields; values a person or agent set are never replaced.',
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
      shareLookups: {
        type: 'boolean',
        label: 'Send company names and websites, and people’s details, to Exa',
        required: true,
        consent: true,
        default: false,
        reconnect: true,
        secret: false,
        description:
          'For a company, only its name and website domain are sent. For a person, their LinkedIn profile address, or their name with the rest of their record: email address, company and the other field values. Skip the People destination to send no people at all. Exa keeps queries unless Retainer’s Exa account has Zero Data Retention, which Exa offers on its Enterprise plan.',
      },
    },

    views: [],
    bindings: ENRICHMENT_BINDINGS,
    functions: [
      {
        universalId: ENRICHMENT.enrichCompanyNow,
        name: 'enrichCompanyNow',
        description: 'Look up this company in Exa and fill its empty mapped fields.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 120,
        trigger: { kind: 'recordButton', binding: 'company', label: 'Enrich now' },
        inputSchema: recordButtonInputSchema,
        scopes: ['read', 'write'],
        mappedWrite: 'company',
        uses: ['model'],
      },
      {
        universalId: ENRICHMENT.enrichPersonNow,
        name: 'enrichPersonNow',
        description: 'Look up this person in Exa and fill their empty mapped fields.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 120,
        trigger: { kind: 'recordButton', binding: 'person', label: 'Enrich now' },
        inputSchema: recordButtonInputSchema,
        scopes: ['read', 'write'],
        mappedWrite: 'person',
        uses: ['model'],
      },
      {
        universalId: ENRICHMENT.configure,
        name: 'configure',
        description:
          'Check the provider connection and suggest where companies, people and each detail go, using a model and a sample of records.',
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
        inputSchema: pageInput,
        scopes: ['read', 'write'],
        mappedWrite: 'company',
        uses: ['model'],
      },
      {
        universalId: ENRICHMENT.backfillPerson,
        name: 'backfillPerson',
        description: 'Fill newly mapped outputs on previously enriched people, in pages.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 300,
        trigger: { kind: 'job' },
        inputSchema: pageInput,
        scopes: ['read', 'write'],
        mappedWrite: 'person',
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
      {
        universalId: ENRICHMENT.enrichPerson,
        name: 'enrichPerson',
        description:
          'Look up a person by their LinkedIn profile, or by name and the rest of their record, when they are created or one of those changes, and fill their empty mapped fields.',
        handlerDigest: build.handlerDigest,
        timeoutSeconds: 120,
        trigger: {
          kind: 'change',
          binding: 'person',
          fields: ['name', 'email', 'company', 'linkedin_url'],
          related: false,
          operations: ['create', 'update'],
        },
        inputSchema: changeInput,
        scopes: ['read', 'write'],
        mappedWrite: 'person',
        uses: ['model'],
      },
    ],
  });
}
