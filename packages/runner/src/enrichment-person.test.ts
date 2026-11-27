import type { Invocation } from '@retainer/extension';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeEnrichment } from './enrichment.js';
import { ENRICHMENT, ENRICHMENT_MODEL, exaPeopleRequest } from './enrichment-contract.js';
import { MEDIUM_CONFIDENCE } from './enrichment-model.js';
import {
  acceptPersonPick,
  lookUpPerson,
  type PersonRecord,
  workEmailDomain,
} from './enrichment-person.js';
import {
  candidateValues,
  companyCandidates,
  ExaProvider,
  linkedinProfile,
  normalizePersonName,
  type PersonCandidate,
  personCandidates,
  personValues,
} from './enrichment-provider.js';
import { runModel } from './model-call.js';

/** Synthetic fixtures in the shape of Exa's responses; no real person or company data. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const message = (output: unknown) =>
  json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: ENRICHMENT_MODEL,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

const COMPANY_PROFILE = `# Acme

## Company Details
- Industry: Software Development
- Homepage: acme.example
- LinkedIn: linkedin.com/company/acme
`;
const company = (properties: Record<string, unknown>) => ({
  url: 'https://www.linkedin.com/company/acme',
  title: 'Acme',
  text: COMPANY_PROFILE,
  entities: [{ type: 'company', properties: { name: 'Acme', ...properties } }],
});

describe('company details (enrichment spec 7.2)', () => {
  it('reads description, industry, founding, money, the latest round and web traffic', () => {
    const [candidate] = companyCandidates({
      results: [
        company({
          foundedYear: 2019,
          description: '  We build   anvils. ',
          financials: {
            revenueAnnual: 27_500_000,
            fundingTotal: 233_200_000,
            fundingLatestRound: { name: 'Series c', date: '2025-07-10', amount: 82_000_000 },
          },
          webTraffic: { visitsMonthly: 9_367_809, countryRank: 3451 },
        }),
      ],
    });
    expect(candidate && candidateValues(candidate)).toMatchObject({
      linkedin_url: { primary: { url: 'https://www.linkedin.com/company/acme' }, additional: [] },
      description: 'We build anvils.',
      industry: 'Software Development',
      founded_year: 2019,
      annual_revenue: { amountMicros: 27_500_000_000_000, currency: 'USD' },
      total_funding: { amountMicros: 233_200_000_000_000, currency: 'USD' },
      last_funding_round: 'Series C',
      last_funding_date: '2025-07-10',
      last_funding_amount: { amountMicros: 82_000_000_000_000, currency: 'USD' },
      monthly_web_visits: 9_367_809,
    });
  });

  it('leaves out what Exa lacks or got wrong, without dropping the company', () => {
    const [candidate] = companyCandidates({
      results: [
        company({
          foundedYear: 3000,
          description: 42,
          financials: {
            revenueAnnual: null,
            fundingTotal: -5,
            fundingLatestRound: { name: 'Seed', date: '2026-02-30', amount: null },
          },
          webTraffic: 'lots',
        }),
      ],
    });
    expect(candidate?.name).toBe('Acme');
    const values = candidate ? candidateValues(candidate) : {};
    expect(values).toMatchObject({ last_funding_round: 'Seed', industry: 'Software Development' });
    for (const key of [
      'founded_year',
      'description',
      'annual_revenue',
      'total_funding',
      'last_funding_date',
      'last_funding_amount',
      'monthly_web_visits',
    ])
      expect(values, key).not.toHaveProperty(key);
  });

  it('cuts a long description at a word boundary and skips an amount too large for micros', () => {
    const [candidate] = companyCandidates({
      results: [
        company({ description: 'word '.repeat(1000), financials: { revenueAnnual: 9e12 } }),
      ],
    });
    const values = candidate ? candidateValues(candidate) : {};
    expect(String(values.description).length).toBeLessThanOrEqual(2001);
    expect(String(values.description).endsWith('word…')).toBe(true);
    expect(values).not.toHaveProperty('annual_revenue');
  });
});

const PERSON_PROFILE = `# Ada Example

Co-Founder, CEO at Acme

San Francisco, California, United States (US)

500 connections • 1,000 followers

## Experience

### CEO, Cofounder - [Acme](https://www.linkedin.com/company/acme) (Current)

Apr 2019 - Present

Department: General Management • Level: C-Level

### Advisor - Beta Corp (Current)

Department: Consulting • Level: Senior

### Designer - [Gamma](https://www.linkedin.com/company/gamma)

Department: Design • Level: Senior
`;
const role = (title: string, name: string, to: string | null) => ({
  title,
  location: null,
  dates: { from: '2019-04-01', to },
  company: { id: null, name },
});
const person = (overrides: { url?: string; text?: string; properties?: object } = {}) => ({
  url: overrides.url ?? 'https://linkedin.com/in/ada-example',
  title: 'Ada Example',
  text: overrides.text ?? PERSON_PROFILE,
  entities: [
    {
      type: 'person',
      properties: {
        name: 'Ada Example',
        location: 'San Francisco, California, United States',
        workHistory: [
          role('Advisor', 'Beta Corp', null),
          role('CEO, Cofounder', 'Acme Inc.', null),
          role('Designer', 'Gamma', '2019-01-01'),
        ],
        ...overrides.properties,
      },
    },
  ],
});

describe('person profiles (enrichment spec 7.2)', () => {
  it('reads the headline, location, LinkedIn profile and roles with their level', () => {
    const [candidate] = personCandidates({ results: [person()] });
    expect(candidate).toMatchObject({
      index: 0,
      name: 'Ada Example',
      headline: 'Co-Founder, CEO at Acme',
      location: 'San Francisco, California, United States',
      linkedin: 'https://www.linkedin.com/in/ada-example',
    });
    expect(candidate?.roles).toEqual([
      {
        title: 'Advisor',
        company: 'Beta Corp',
        current: true,
        department: 'Consulting',
        level: 'Senior',
      },
      {
        title: 'CEO, Cofounder',
        company: 'Acme Inc.',
        current: true,
        department: 'General Management',
        level: 'C-Level',
      },
      { title: 'Designer', company: 'Gamma', current: false, department: null, level: null },
    ]);
  });

  it('takes the role at the record’s company, not the first current one', () => {
    const [candidate] = personCandidates({ results: [person()] });
    expect(candidate && personValues(candidate, 'ACME')).toEqual({
      job_title: 'CEO, Cofounder',
      seniority: 'C-Level',
      department: 'General Management',
      headline: 'Co-Founder, CEO at Acme',
      location: 'San Francisco, California, United States',
      linkedin_url: { primary: { url: 'https://www.linkedin.com/in/ada-example' }, additional: [] },
    });
    // Two current roles and no company to choose by: no title rather than a guess.
    expect(candidate && personValues(candidate, null)).not.toHaveProperty('job_title');
  });

  it.each([
    ['# Ada Example\n\nSan Francisco, California, United States (US)\n\n500 connections'],
    ['# Ada Example\n\nUnited States (US)\n'],
    ['# Ada Example\n\n500 connections • 9 followers\n'],
    ['# Ada Example\n\n## About\n'],
  ])('has no headline when the line after the name is not one: %j', (text) => {
    const [candidate] = personCandidates({ results: [person({ text })] });
    expect(candidate?.headline).toBeNull();
  });

  it.each([
    ['https://www.linkedin.com/in/ada-example/', 'https://www.linkedin.com/in/ada-example'],
    ['https://uk.linkedin.com/in/ada_2?trk=x', 'https://www.linkedin.com/in/ada_2'],
    ['http://linkedin.com/in/ada', 'https://www.linkedin.com/in/ada'],
    ['https://linkedin.com/company/acme', null],
    ['https://linkedin.com.evil.example/in/ada', null],
    ['https://ada.example/in/ada', null],
  ])('reads %j as LinkedIn profile %j', (url, profile) => {
    expect(linkedinProfile(url)).toBe(profile);
  });

  it('drops results without a person entity', () => {
    expect(
      personCandidates({ results: [company({}), { url: 'https://x.example', entities: [] }] }),
    ).toEqual([]);
  });

  it.each([
    ['Ada Example', 'ada example'],
    ['Ada María Example', 'ada example'],
    ['ADA EXAMPLE-SMITH', 'ada smith'],
    ['Ada', 'ada'],
  ])('compares the name %j as %j', (name, normalized) => {
    expect(normalizePersonName(name)).toBe(normalized);
  });

  it('searches by name and company only', () => {
    expect(exaPeopleRequest(' Ada  Example ', { name: 'Acme', domain: 'acme.example' })).toEqual({
      query: 'Ada Example Acme acme.example',
      type: 'auto',
      category: 'people',
      numResults: 5,
      contents: { text: { maxCharacters: 4000 } },
    });
    expect(exaPeopleRequest('Ada', { name: null, domain: 'acme.example' }).query).toBe(
      'Ada acme.example',
    );
  });
});

describe('work email domains', () => {
  it.each([
    ['ada@acme.example', 'acme.example'],
    ['Ada@Mail.ACME.example', 'mail.acme.example'],
    ['ada@gmail.com', null],
    ['ada@proton.me', null],
    ['not-an-email', null],
    [null, null],
  ])('reads %j as %j', (email, domain) => {
    expect(workEmailDomain(email)).toBe(domain);
  });
});

const candidate = (overrides: Partial<PersonCandidate> = {}): PersonCandidate => ({
  index: 0,
  url: 'https://linkedin.com/in/ada',
  name: 'Ada Example',
  headline: null,
  location: null,
  linkedin: 'https://www.linkedin.com/in/ada',
  roles: [{ title: 'CEO', company: 'Acme', current: true, department: null, level: null }],
  ...overrides,
});

describe('the guards on a person pick (spec 7.3)', () => {
  it.each([
    ['high, same name, works there', 'high', {}, 'Acme', true],
    ['medium, same name, works there', 'medium', {}, 'Acme', true],
    ['low', 'low', {}, 'Acme', false],
    ['another name', 'high', { name: 'Ada Other' }, 'Acme', false],
    [
      'medium, worked there before',
      'medium',
      { roles: [{ title: 'CEO', company: 'Acme', current: false, department: null, level: null }] },
      'Acme',
      false,
    ],
    ['medium, company unknown', 'medium', {}, null, false],
    ['high, company unknown', 'high', {}, null, true],
    ['high, another company', 'high', {}, 'Beta', true],
  ] as const)('%s', (_case, certainty, overrides, company, accepted) => {
    expect(
      acceptPersonPick(
        { candidate: candidate(overrides as Partial<PersonCandidate>), certainty },
        { name: 'Ada Example', company },
      ),
    ).toBe(accepted);
  });
});

function fakes(results: unknown[], answer = () => message({ index: 0, certainty: 'high' })) {
  const calls = { exa: [] as { path: string; body: unknown }[], model: [] as unknown[] };
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (target.origin === 'https://api.exa.ai') {
      calls.exa.push({ path: target.pathname, body });
      return json({ results });
    }
    if (target.origin === 'https://model.test') {
      calls.model.push(body);
      return answer();
    }
    throw new Error(`unexpected request ${target}`);
  };
  const signal = new AbortController().signal;
  const invocation = {
    deadline: new Date(Date.now() + 60_000).toISOString(),
    model: { origin: 'https://model.test', token: 'rt_model_fixture' },
  } as Invocation;
  return {
    calls,
    run: {
      exa: new ExaProvider('exa-key', signal, transport),
      model: () => runModel(invocation, transport)?.withOptions({ maxRetries: 0 }) ?? null,
      signal,
    },
  };
}
const record = (overrides: Partial<PersonRecord> = {}): PersonRecord => ({
  name: 'Ada Example',
  email: 'ada@acme.example',
  linkedin: null,
  company: { name: 'Acme', domain: 'acme.example' },
  ...overrides,
});

describe('the people lookup (spec 7.3)', () => {
  it('reads a LinkedIn profile on the record directly, without a search or the model', async () => {
    const f = fakes([person()]);
    const found = await lookUpPerson(
      f.run,
      record({ linkedin: 'https://uk.linkedin.com/in/ada-example/' }),
    );
    expect(found).toMatchObject({ status: 'match', confidence: 1, code: 'matched_linkedin' });
    expect(f.calls.exa).toEqual([
      {
        path: '/contents',
        body: { urls: ['https://www.linkedin.com/in/ada-example'], text: { maxCharacters: 4000 } },
      },
    ]);
    expect(f.calls.model).toEqual([]);
  });

  it('accepts the one candidate with the same name and a current role at the company', async () => {
    const f = fakes([person({ properties: { name: 'Ada Other' } }), person()]);
    const found = await lookUpPerson(f.run, record());
    expect(found).toMatchObject({
      status: 'match',
      confidence: 1,
      code: 'matched_shortcut',
      values: { job_title: 'CEO, Cofounder' },
    });
    expect(f.calls.model).toEqual([]);
  });

  it('never sends the email address, only its domain when there is no linked company', async () => {
    const f = fakes([person()]);
    await lookUpPerson(f.run, record({ company: null }));
    expect(JSON.stringify(f.calls)).not.toContain('ada@');
    expect(f.calls.exa[0]?.body).toMatchObject({ query: 'Ada Example acme.example' });
  });

  it('asks the model when the shortcut can’t decide, and applies a medium pick at reduced confidence', async () => {
    const f = fakes([person(), person()], () => message({ index: 1, certainty: 'medium' }));
    const found = await lookUpPerson(f.run, record());
    expect(found).toMatchObject({
      status: 'match',
      confidence: MEDIUM_CONFIDENCE,
      code: 'matched_model_medium',
    });
    const prompt = JSON.stringify(f.calls.model[0]);
    expect(prompt).toContain('<profiles>');
    expect(prompt).not.toContain('ada@acme.example');
  });

  it.each([
    ['no name', record({ name: ' ' }), 'no_name'],
    [
      'a personal email and no company',
      record({ email: 'ada@gmail.com', company: null }),
      'no_company',
    ],
  ])('doesn’t search with %s', async (_case, input, code) => {
    const f = fakes([person()]);
    expect(await lookUpPerson(f.run, input)).toEqual({ status: 'no_match', code });
    expect(f.calls.exa).toEqual([]);
  });

  it('refuses a pick whose name differs, even at high certainty', async () => {
    const f = fakes([person({ properties: { name: 'Bob Example' } })]);
    expect(await lookUpPerson(f.run, record())).toEqual({
      status: 'no_match',
      code: 'no_match_model',
    });
  });

  it('skips a name-only search with multiple matching people before calling the model', async () => {
    const f = fakes([person(), person({ url: 'https://linkedin.com/in/ada-other-profile' })]);
    expect(await lookUpPerson(f.run, record({ company: null, email: null }), true)).toEqual({
      status: 'no_match',
      code: 'no_match',
    });
    expect(f.calls.exa[0]?.body).toMatchObject({ query: 'Ada Example' });
    expect(f.calls.model).toEqual([]);
  });

  it('is no match when the LinkedIn profile has no person', async () => {
    const f = fakes([]);
    expect(await lookUpPerson(f.run, record({ linkedin: 'https://linkedin.com/in/ada' }))).toEqual({
      status: 'no_match',
      code: 'no_match_linkedin',
    });
  });
});

describe('a person change run (spec 7.5)', () => {
  beforeEach(() => vi.stubEnv('EXA_API_KEY', 'deployment-key'));
  afterEach(() => vi.unstubAllEnvs());
  const id = () => crypto.randomUUID();
  const plan = {
    bindings_revision: 1,
    createPeople: 'never',
    bindings: {
      company: {
        status: 'ok',
        objects: [{ id: id(), name: 'organization', label: 'Organizations' }],
        fields: {
          domain: { id: id(), name: 'website', label: 'Website', values: {} },
          name: { id: id(), name: 'title', label: 'Title', values: {} },
        },
      },
      person: {
        status: 'ok',
        objects: [{ id: id(), name: 'contact', label: 'Contacts' }],
        fields: {
          name: { id: id(), name: 'fullName', label: 'Name', values: {} },
          email: { id: id(), name: 'emails', label: 'Emails', values: {} },
          company: { id: id(), name: 'employer', label: 'Employer', values: {} },
          job_title: { id: id(), name: 'title', label: 'Title', values: {} },
          seniority: { id: id(), name: 'level', label: 'Level', values: {} },
          linkedin_url: { id: id(), name: 'linkedin', label: 'LinkedIn', values: {} },
        },
      },
    },
  };

  function run(fields: Record<string, unknown>) {
    const writes: unknown[] = [];
    const exa: unknown[] = [];
    const orgId = id();
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (target.origin === 'https://api.exa.ai') {
        exa.push(body);
        return json({ results: [person()] });
      }
      if (target.pathname === '/v1/extensions/installation/bindings') return json(plan);
      if (target.pathname.startsWith('/v1/changes/'))
        return json({ position: '7', recordId: 'p1', operation: 'create' });
      if (target.pathname === '/v1/records/p1')
        return json({ id: 'p1', label: 'Ada', fields: { ...fields, employer: orgId } });
      if (target.pathname === `/v1/records/${orgId}`)
        return json({
          id: orgId,
          label: 'Acme',
          fields: { title: 'Acme', website: { primary: { url: 'https://www.acme.example/' } } },
        });
      if (target.pathname.endsWith('/runtime/mapped-writes')) {
        writes.push(body);
        return json({ outcome: 'applied', fields: {} });
      }
      throw new Error(`unexpected request ${target}`);
    });
    const invocation: Invocation = {
      protocolVersion: 1,
      runId: id(),
      attempt: 1,
      installationId: 'installation',
      releaseDigest: 'd'.repeat(64),
      functionId: ENRICHMENT.enrichPerson,
      input: { changePosition: '7' },
      apiOrigin: 'https://retainer.test',
      runToken: 'rt',
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    return {
      writes,
      exa,
      result: executeEnrichment(invocation, new AbortController().signal, transport),
    };
  }

  it('looks the person up by name and linked company and fills only their open fields', async () => {
    const r = run({
      fullName: { first: 'Ada', last: 'Example' },
      emails: { primary: 'Ada@Acme.example', additional: [] },
      level: 'Senior',
    });
    expect(await r.result).toEqual({ status: 'succeeded', code: 'matched_shortcut' });
    expect(r.exa).toEqual([
      exaPeopleRequest('Ada Example', { name: 'Acme', domain: 'acme.example' }),
    ]);
    expect(r.writes).toEqual([
      {
        recordId: 'p1',
        lookup: 'ada@acme.example',
        binding: 'person',
        values: {
          job_title: 'CEO, Cofounder',
          linkedin_url: {
            primary: { url: 'https://www.linkedin.com/in/ada-example' },
            additional: [],
          },
        },
      },
    ]);
  });

  it('stops before Exa when every mapped field is set', async () => {
    const r = run({
      fullName: { first: 'Ada', last: 'Example' },
      title: 'CEO',
      level: 'Senior',
      linkedin: { primary: { url: 'https://linkedin.com/in/ada' } },
    });
    expect(await r.result).toEqual({ status: 'succeeded', code: 'nothing_to_fill' });
    expect(r.exa).toEqual([]);
  });
});

describe('setup (spec 7.5)', () => {
  beforeEach(() => vi.stubEnv('EXA_API_KEY', 'deployment-key'));
  afterEach(() => vi.unstubAllEnvs());
  const uuid = () => crypto.randomUUID();
  const destination = (object: string, fields: string[]) => ({
    status: 'ok',
    objects: [{ id: uuid(), name: object, label: object }],
    fields: Object.fromEntries(
      fields.map((key) => [key, { id: uuid(), name: key, label: key, values: {} }]),
    ),
  });

  it('queues a backfill only for a binding whose upgrade maps a new output', async () => {
    const checkpoints: unknown[] = [];
    const known: Record<string, string[]> = {
      mappedOutputs: ['employee_count'],
      mappedPersonOutputs: ['job_title'],
    };
    const transport: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (target.origin === 'https://api.exa.ai') return json({ id: 'team' });
      if (target.pathname.includes('/runtime/kv/')) {
        const key = decodeURIComponent(target.pathname.split('/').pop() ?? '');
        return json({ key, revision: 3, value: known[key] });
      }
      if (target.pathname.endsWith('/runtime/checkpoint')) {
        checkpoints.push(body);
        return json({ children: [] });
      }
      throw new Error(`unexpected request ${target}`);
    };
    const runId = uuid();
    const result = await executeEnrichment(
      {
        protocolVersion: 1,
        runId,
        attempt: 1,
        installationId: 'installation',
        releaseDigest: 'd'.repeat(64),
        functionId: ENRICHMENT.setup,
        input: { previousVersion: '1.0.0' },
        apiOrigin: 'https://retainer.test',
        runToken: 'rt',
        deadline: new Date(Date.now() + 60_000).toISOString(),
        bindings: {
          bindings_revision: 2,
          createPeople: 'never',
          bindings: {
            company: destination('company', ['domain', 'employee_count']),
            person: destination('contact', ['name', 'job_title', 'seniority']),
          },
        },
      } as Invocation,
      new AbortController().signal,
      transport,
    );
    expect(result).toEqual({ status: 'succeeded' });
    expect(checkpoints).toEqual([
      {
        children: [],
        kv: { key: 'mappedOutputs', expectedRevision: 3, value: ['employee_count'] },
      },
      {
        children: [
          {
            functionId: ENRICHMENT.backfillPerson,
            input: {},
            dedupeKey: `backfill:person:${runId}`,
          },
        ],
        kv: {
          key: 'mappedPersonOutputs',
          expectedRevision: 3,
          value: ['job_title', 'seniority'],
        },
      },
    ]);
  });
});
