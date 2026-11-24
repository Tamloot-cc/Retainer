import type { Invocation } from '@retainer/extension';
import { RetainerClient } from '@retainer/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerSchema } from './binding-suggestions.js';
import { executeEnrichment, lookUp, MEDIUM_CONFIDENCE } from './enrichment.js';
import {
  ENRICHMENT,
  ENRICHMENT_BINDINGS,
  ENRICHMENT_MODEL,
  enrichmentManifest,
  exaSearchRequest,
} from './enrichment-contract.js';
import {
  acceptPick,
  type Candidate,
  candidateValues,
  companyCandidates,
  ExaProvider,
  normalizeCompanyName,
  shortcut,
} from './enrichment-provider.js';
import { runModel } from './model-call.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const entity = (properties: Record<string, unknown>) => ({ type: 'company', properties });
/** One synthetic Exa result; no real company data. */
const result = (url: string, text = '', properties: Record<string, unknown> = {}) => ({
  url,
  title: 'Fixture title',
  text,
  entities: [entity({ name: 'Acme', ...properties })],
});

describe('Exa company candidates', () => {
  it('reads the name, homepage, count, LinkedIn page and headquarters of each company result', () => {
    const [candidate] = companyCandidates({
      results: [
        result(
          'https://www.acme.example/',
          '## Company Details\n- Homepage: acme.example\n- LinkedIn: linkedin.com/company/acme\n',
          {
            workforce: { total: 12.6 },
            headquarters: {
              address: 'City, ST, US',
              city: ' City ',
              postalCode: '',
              country: 'US',
            },
          },
        ),
      ],
    });
    expect(candidate).toMatchObject({
      index: 0,
      url: 'https://www.acme.example/',
      name: 'Acme',
      homepage: 'acme.example',
    });
    expect(candidate && candidateValues(candidate)).toEqual({
      employee_count: 13,
      linkedin_url: { primary: { url: 'https://www.linkedin.com/company/acme' }, additional: [] },
      headquarters: { city: 'City', country: 'US' },
    });
  });

  it('drops results without a company entity and numbers the rest in order', () => {
    const candidates = companyCandidates({
      results: [
        { url: 'https://person.example/', entities: [{ type: 'person' }] },
        { url: 'https://none.example/', entities: [] },
        result('https://a.example/'),
        result('https://b.example/', '', { name: null }),
      ],
    });
    expect(candidates.map((c) => [c.index, c.url, c.name])).toEqual([
      [0, 'https://a.example/', 'Acme'],
      [1, 'https://b.example/', 'Fixture title'],
    ]);
  });

  it('keeps the first 1,500 characters of a profile as its excerpt', () => {
    const [candidate] = companyCandidates({
      results: [result('https://a.example/', 'x'.repeat(4000))],
    });
    expect(candidate?.excerpt).toHaveLength(1500);
  });

  it.each([
    ['- LinkedIn: https://www.linkedin.com/company/acme-inc/', 'acme-inc'],
    ['- LinkedIn: uk.linkedin.com/company/acme_2', 'acme_2'],
    ['- LinkedIn: linkedin.com/in/a-person', undefined],
    ['- LinkedIn: linkedin.com.evil.example/company/acme', undefined],
    ['LinkedIn: linkedin.com/company/acme', undefined],
    ['- LinkedIn: linkedin.com/company/acme?trk=x', undefined],
  ])('reads %j strictly', (line, slug) => {
    const [candidate] = companyCandidates({ results: [result('https://acme.example/', line)] });
    expect(candidate?.linkedin).toBe(slug ? `https://www.linkedin.com/company/${slug}` : null);
  });

  it.each([[-1], [10_000_001], [Number.NaN], [null]])('drops an employee count of %s', (total) => {
    const [candidate] = companyCandidates({
      results: [result('https://acme.example/', '', { workforce: { total } })],
    });
    expect(candidate ? 'employee_count' in candidateValues(candidate) : false).toBe(false);
  });

  it('searches by name and domain across all domains, or by the domain alone', () => {
    expect(exaSearchRequest('acme.example', '  Acme   Inc ')).toEqual({
      query: 'Acme Inc acme.example',
      type: 'auto',
      category: 'company',
      numResults: 5,
      contents: { text: { maxCharacters: 4000 } },
    });
    expect(exaSearchRequest('acme.example', null).query).toBe('acme.example');
    expect(exaSearchRequest('acme.example', ' ').query).toBe('acme.example');
  });
});

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  index: 0,
  url: 'https://acme.example/',
  name: 'Acme',
  homepage: null,
  linkedin: null,
  headquarters: null,
  workforce: 12,
  excerpt: '',
  details: {
    industry: null,
    foundedYear: null,
    description: null,
    revenue: null,
    funding: null,
    lastRound: null,
    visits: null,
  },
  ...overrides,
});

describe('the shortcut (spec 6.3, step 3)', () => {
  it('accepts exactly one candidate on the domain whose Homepage line agrees', () => {
    const on = candidate({ index: 1, url: 'https://www.acme.example/', homepage: 'acme.example' });
    expect(shortcut('acme.example', [candidate({ url: 'https://other.example/' }), on])).toBe(on);
  });
  it.each([
    ['no candidate on the domain', [candidate({ url: 'https://other.example/' })]],
    ['a Homepage line naming another domain', [candidate({ homepage: 'other.example' })]],
    ['two candidates on the domain', [candidate(), candidate({ index: 1 })]],
  ])('has no shortcut for %s', (_case, candidates) => {
    expect(shortcut('acme.example', candidates)).toBeUndefined();
  });
});

describe('the guards on a model pick (spec 6.3)', () => {
  const record = { domain: 'acme.example', name: 'ACME, Inc.' };
  it.each([
    ['on the domain at high', candidate(), 'high', true],
    ['on the domain at medium', candidate(), 'medium', true],
    ['on the domain at low', candidate(), 'low', false],
    [
      'on the domain by its Homepage line',
      candidate({ url: 'https://acme.example.redirect/', homepage: 'acme.example' }),
      'medium',
      true,
    ],
    [
      'elsewhere at high with the same name',
      candidate({ url: 'https://acme.example.org/' }),
      'high',
      true,
    ],
    [
      'elsewhere at medium with the same name',
      candidate({ url: 'https://acme.example.org/' }),
      'medium',
      false,
    ],
    [
      'elsewhere at high with another name',
      candidate({ url: 'https://acme.example.org/', name: 'Acme Labs' }),
      'high',
      false,
    ],
    [
      'elsewhere at high with no name',
      candidate({ url: 'https://acme.example.org/', name: null }),
      'high',
      false,
    ],
  ] as const)('a pick %s is accepted: %s', (_case, picked, certainty, accepted) => {
    expect(acceptPick({ candidate: picked, certainty }, record)).toBe(accepted);
  });
  it('needs the record to have a name for a pick on another domain', () => {
    const picked = candidate({ url: 'https://acme.example.org/' });
    expect(acceptPick({ candidate: picked, certainty: 'high' }, { ...record, name: null })).toBe(
      false,
    );
  });
  it.each([
    ['ACME, Inc.', 'acme'],
    ['Acme Ltd', 'acme'],
    ['Société Générale S.A.', 'societe generale'],
    ['Smith & Sons LLC', 'smith and sons'],
    ['Inc', 'inc'],
  ])('normalizes the name %j to %j', (name, normalized) => {
    expect(normalizeCompanyName(name)).toBe(normalized);
  });
});

type Answer = (request: { body: Record<string, unknown> }) => Response;
/** An Anthropic Messages answer with structured output. */
const message = (output: unknown, stop_reason = 'end_turn') =>
  json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: ENRICHMENT_MODEL,
    content: stop_reason === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

/** A run against fakes: Exa and the model proxy. The lookup never calls Retainer's API. */
function fakes(
  results: unknown[],
  answer: Answer = () => message({ index: 0, certainty: 'high' }),
) {
  const calls = { exa: [] as Record<string, unknown>[], model: [] as Record<string, unknown>[] };
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (target.origin === 'https://api.exa.ai') {
      calls.exa.push(body);
      return json({ results });
    }
    if (target.origin === 'https://model.test') {
      calls.model.push({ ...body, headers: Object.fromEntries(new Headers(init?.headers)) });
      return answer({ body });
    }
    throw new Error(`unexpected request ${target}`);
  };
  const signal = new AbortController().signal;
  const sdk = new RetainerClient({
    baseUrl: 'https://retainer.test',
    apiKey: 'rt',
    fetch: transport,
  });
  const invocation = {
    deadline: new Date(Date.now() + 60_000).toISOString(),
    model: { origin: 'https://model.test', token: 'rt_model_fixture' },
  } as Invocation;
  const run = {
    sdk,
    installationId: 'installation',
    exa: new ExaProvider('exa-key', signal, transport),
    model: () => runModel(invocation, transport)?.withOptions({ maxRetries: 0 }) ?? null,
    signal,
  };
  const record = {
    name: 'Acme',
    domain: 'acme.example',
    context: { employee_count: 40 },
  };
  return { calls, run, record };
}

describe('the lookup (spec 6.3-6.5)', () => {
  it('accepts the shortcut without calling the model, at full confidence', async () => {
    const f = fakes([result('https://other.example/'), result('https://www.acme.example/')]);
    expect(await lookUp(f.run, f.record)).toMatchObject({
      status: 'match',
      confidence: 1,
      code: 'matched_shortcut',
    });
    expect(f.calls.model).toEqual([]);
    expect(f.calls.exa[0]?.query).toBe('Acme acme.example');
  });

  it('is no match without a model call when no result is a company', async () => {
    const f = fakes([]);
    expect(await lookUp(f.run, f.record)).toEqual({ status: 'no_match', code: 'no_match' });
    expect(f.calls.model).toEqual([]);
  });

  it('asks the model with the record and the candidates as untrusted content', async () => {
    const f = fakes([result('https://acme.example.org/'), result('https://acme.example.net/')]);
    expect(await lookUp(f.run, f.record)).toMatchObject({
      status: 'match',
      confidence: 1,
      code: 'matched_model_high',
    });
    const [call] = f.calls.model;
    expect(call).toMatchObject({
      model: ENRICHMENT_MODEL,
      max_tokens: 4000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      headers: {
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        authorization: 'Bearer rt_model_fixture',
      },
    });
    const user = JSON.stringify(call?.messages);
    expect(user).toContain('<profiles>');
    expect(user).toContain('acme.example.net');
    expect(user).toContain('employee_count');
  });

  it('applies a medium pick on the domain at reduced confidence', async () => {
    const f = fakes(
      [
        result('https://acme.example/', '- Homepage: acme.example'),
        result('https://acme.example/'),
      ],
      () => message({ index: 1, certainty: 'medium' }),
    );
    expect(await lookUp(f.run, f.record)).toMatchObject({
      status: 'match',
      confidence: MEDIUM_CONFIDENCE,
      code: 'matched_model_medium',
    });
  });

  it.each([
    ['no company', { index: null, certainty: 'high' }, 'no_match_model'],
    ['a low pick', { index: 0, certainty: 'low' }, 'no_match_model'],
    ['a medium pick on another domain', { index: 0, certainty: 'medium' }, 'no_match_model'],
    ['an index it was not sent', { index: 7, certainty: 'high' }, 'no_match_model_output'],
    ['output outside the schema', { pick: 0 }, 'no_match_model_output'],
  ])('is no match for %s', async (_case, output, code) => {
    const f = fakes([result('https://acme.example.org/')], () => message(output));
    expect(await lookUp(f.run, f.record)).toEqual({ status: 'no_match', code });
  });

  it.each([
    ['a refusal after any fallback', () => message(null, 'refusal'), 'no_match_model_refused'],
    [
      'output cut off at max_tokens',
      () => message({ index: 0 }, 'max_tokens'),
      'no_match_model_output',
    ],
    [
      'no model key on a self-hosted server',
      () => json({ type: 'error', error: { type: 'model_unavailable', message: 'x' } }, 503),
      'no_match_model_unavailable',
    ],
  ])('is no match for %s', async (_case, answer, code) => {
    const f = fakes([result('https://acme.example.org/')], answer);
    expect(await lookUp(f.run, f.record)).toEqual({ status: 'no_match', code });
  });

  it('is no match as unavailable when the run has no model', async () => {
    const f = fakes([result('https://acme.example.org/')]);
    expect(await lookUp({ ...f.run, model: () => null }, f.record)).toEqual({
      status: 'no_match',
      code: 'no_match_model_unavailable',
    });
  });

  it.each([
    [429, 'model_rate_limited'],
    [500, 'model_unavailable'],
    [529, 'model_unavailable'],
  ])('retries a %i after the SDK’s own retries', async (status, code) => {
    const f = fakes([result('https://acme.example.org/')], () =>
      json({ type: 'error', error: { type: 'x', message: 'x' } }, status, { 'retry-after': '9' }),
    );
    await expect(lookUp(f.run, f.record)).rejects.toMatchObject({ code, retryAfterSeconds: 9 });
  });

  it('fails a request the proxy refuses as invalid', async () => {
    const f = fakes([result('https://acme.example.org/')], () =>
      json({ type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, 400),
    );
    await expect(lookUp(f.run, f.record)).rejects.toMatchObject({
      message: 'model_request_failed',
    });
  });

  it('keeps nothing between attempts: a second lookup asks the model again', async () => {
    const f = fakes([result('https://acme.example.org/')]);
    await lookUp(f.run, f.record);
    await lookUp(f.run, f.record);
    expect(f.calls.model).toHaveLength(2);
  });
});

describe('configure (spec 6.1, enrichment spec 7.4)', () => {
  const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name,
    label: name,
    type,
    readOnly: false,
    settings: {},
    description: null,
    ...extra,
  });
  const schema = {
    objects: [
      {
        nameSingular: 'company',
        labelPlural: 'Companies',
        class: 'entity',
        description: null,
        labelField: 'name',
        fields: [
          field('name', 'text'),
          field('domain', 'links'),
          field('size', 'number'),
          field('dealSize', 'number'),
          field('linkedinUrl', 'links'),
          field('score', 'number', { readOnly: true }),
        ],
      },
      {
        nameSingular: 'contact',
        labelPlural: 'Contacts',
        class: 'entity',
        description: null,
        labelField: 'fullName',
        fields: [
          field('fullName', 'full_name'),
          field('emails', 'emails'),
          field('title', 'text'),
          field('employer', 'relation', {
            settings: { targetObject: 'company', relationCardinality: 'many_to_one' },
          }),
          field('club', 'relation', {
            settings: { targetObject: 'contact', relationCardinality: 'many_to_one' },
          }),
        ],
      },
      {
        nameSingular: 'meeting',
        labelPlural: 'Meetings',
        class: 'event',
        description: null,
        labelField: 'title',
        fields: [field('title', 'text')],
      },
    ],
  };
  beforeEach(() => vi.stubEnv('EXA_API_KEY', 'deployment-key'));
  afterEach(() => vi.unstubAllEnvs());

  function configure(answer: Answer, reason = 'install') {
    const saved: unknown[] = [];
    const prompts: string[] = [];
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (target.origin === 'https://api.exa.ai') {
        expect(new Headers(init?.headers).get('x-api-key')).toBe('deployment-key');
        return json({ id: 'team' });
      }
      if (target.origin === 'https://model.test') {
        prompts.push(JSON.stringify(body));
        return answer({ body });
      }
      if (target.pathname === '/v1/schema') return json(schema);
      if (target.pathname === '/v1/objects/company/query')
        return json({
          records: [
            { id: 'a', label: 'Acme', fields: { size: 12, dealSize: 50000, linkedinUrl: null } },
            { id: 'b', label: 'Beta', fields: { size: 340, dealSize: 9000 } },
          ],
          nextCursor: null,
        });
      if (target.pathname === '/v1/objects/contact/query')
        return json({
          records: [{ id: 'c', label: 'Ada', fields: { title: 'CTO' } }],
          nextCursor: null,
        });
      if (target.pathname === '/v1/extensions/installation/bindings')
        return json({
          bindings_revision: 1,
          createPeople: 'never',
          bindings: {
            company: {
              status: 'ok',
              objects: [{ id: crypto.randomUUID(), name: 'company', label: 'Companies' }],
              fields: {
                domain: { id: crypto.randomUUID(), name: 'domain', label: 'Domain', values: {} },
              },
            },
          },
        });
      if (target.pathname.endsWith('/runtime/suggestions')) {
        saved.push(body);
        return json({ saved: true });
      }
      throw new Error(`unexpected request ${target}`);
    });
    const invocation: Invocation = {
      protocolVersion: 1,
      runId: 'run',
      attempt: 1,
      installationId: 'installation',
      releaseDigest: 'd'.repeat(64),
      functionId: ENRICHMENT.configure,
      input: { reason, previousVersion: null, newOutputs: [] },
      apiOrigin: 'https://retainer.test',
      runToken: 'rt',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      model: { origin: 'https://model.test', token: 'rt_model_fixture' },
    };
    return {
      saved,
      prompts,
      transport,
      run: () => executeEnrichment(invocation, new AbortController().signal, transport),
    };
  }
  const pick = (action: string, field: string, reason = 'Because.') => ({
    action,
    field,
    reason,
  });
  const answer = (company: Record<string, unknown>, person: Record<string, unknown>) =>
    message({
      company: {
        action: 'existing',
        object: 'company',
        reason: 'Holds companies.',
        fields: company,
      },
      person: { action: 'existing', object: 'contact', reason: 'Holds people.', fields: person },
    });

  it('fails without making any requests when the deployment key is blank', async () => {
    vi.stubEnv('EXA_API_KEY', ' ');
    const c = configure(() => {
      throw new Error('unexpected model request');
    });
    expect(await c.run()).toEqual({ status: 'failed', code: 'provider_not_configured' });
    expect(c.transport).not.toHaveBeenCalled();
  });

  it('asks the model where companies and people go, with sampled values, and saves what fits', async () => {
    const c = configure(() =>
      answer(
        {
          domain: pick('existing', 'domain'),
          name: pick('existing', 'name'),
          employee_count: pick('existing', 'size'),
          linkedin_url: pick('create', ''),
          headquarters: pick('skip', ''),
        },
        {
          name: pick('existing', 'fullName'),
          email: pick('existing', 'emails'),
          company: pick('existing', 'employer'),
          job_title: pick('existing', 'title'),
          seniority: pick('skip', ''),
        },
      ),
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved).toEqual([
      {
        bindings: {
          company: {
            action: 'existing',
            objects: ['company'],
            fields: {
              domain: { action: 'existing', field: 'domain' },
              name: { action: 'existing', field: 'name' },
              employee_count: { action: 'existing', field: 'size' },
              linkedin_url: { action: 'create' },
              headquarters: { action: 'skip' },
            },
          },
          person: {
            action: 'existing',
            objects: ['contact'],
            fields: {
              name: { action: 'existing', field: 'fullName' },
              email: { action: 'existing', field: 'emails' },
              company: { action: 'existing', field: 'employer' },
              job_title: { action: 'existing', field: 'title' },
              seniority: { action: 'skip' },
            },
          },
        },
        bindingReasons: expect.objectContaining({
          company: 'Holds companies.',
          person: 'Holds people.',
          'company.employee_count': 'Because.',
          'person.company': 'Because.',
        }),
      },
    ]);
    const request = JSON.parse(c.prompts[0] ?? '{}');
    expect(request.model).toBe(ENRICHMENT_MODEL);
    const sent = JSON.parse(request.messages[0].content);
    expect(sent.bindings.map((b: { key: string }) => b.key)).toEqual(['company', 'person']);
    const companies = sent.bindings[0].candidates;
    // Event types are never candidates for an entity binding.
    expect(companies.map((o: { name: string }) => o.name)).toEqual(['company', 'contact']);
    const size = companies[0].fields.find((f: { name: string }) => f.name === 'size');
    expect(size.samples).toEqual([12, 340]);
    // Read-only fields are never offered.
    expect(companies[0].fields.map((f: { name: string }) => f.name)).not.toContain('score');
    expect(sent.currentBindings).toBeUndefined();
  });

  it('drops choices the schema cannot take, so the server default applies to them', async () => {
    const c = configure(
      () =>
        answer(
          {
            domain: pick('existing', 'domain'),
            employee_count: pick('existing', 'score'),
            linkedin_url: pick('existing', 'missing'),
          },
          { name: pick('existing', 'fullName'), company: pick('existing', 'club') },
        ),
      'requested',
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved[0]).toMatchObject({
      bindings: {
        company: { fields: { domain: { action: 'existing', field: 'domain' } } },
        person: { fields: { name: { action: 'existing', field: 'fullName' } } },
      },
    });
    const { company, person } = (c.saved[0] as { bindings: Record<string, { fields: object }> })
      .bindings;
    expect(Object.keys(company?.fields ?? {})).toEqual(['domain']);
    // A relation that doesn't point at the company binding's object is dropped.
    expect(Object.keys(person?.fields ?? {})).toEqual(['name']);
    expect(c.prompts[0]).toContain('currentBindings');
  });

  it.each([
    [
      'the proxy has no key',
      () => json({ type: 'error', error: { type: 'model_unavailable', message: 'x' } }, 503),
    ],
    ['the model refuses', () => message(null, 'refusal')],
    ['the output does not parse', () => message({ company: 'company' })],
    [
      'the provider is down',
      () => json({ type: 'error', error: { type: 'x', message: 'x' } }, 500),
    ],
  ])('falls back to name-and-type suggestions for companies when %s', async (_case, reply) => {
    const c = configure(reply);
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready_without_model' });
    expect(c.saved[0]).toMatchObject({
      bindings: {
        company: {
          action: 'existing',
          objects: ['company'],
          fields: {
            employee_count: { action: 'create' },
            linkedin_url: { action: 'existing', field: 'linkedinUrl' },
            headquarters: { action: 'create' },
            monthly_web_visits: { action: 'create' },
          },
        },
      },
      bindingReasons: {
        'company.employee_count': expect.any(String),
        'company.linkedin_url': expect.any(String),
      },
    });
    expect(Object.keys((c.saved[0] as { bindings: object }).bindings)).toEqual(['company']);
  });
});

describe('configure answer schema', () => {
  it('has no union-typed property, however many outputs the bindings declare', () => {
    // Structured output allows at most 16 union-typed properties.
    expect(JSON.stringify(answerSchema(ENRICHMENT_BINDINGS))).not.toMatch(/"anyOf"|"type":\[/);
  });
});

describe('enrichment manifest', () => {
  const manifest = enrichmentManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  it('declares the company outputs, the domain lookup and a narrow mapped-write trigger', () => {
    expect(manifest.requestedActor).toBe('agent');
    const company = manifest.bindings?.find((binding) => binding.key === 'company');
    expect(
      company?.fields
        .filter((field) => !field.lookup)
        .map((field) => [field.key, field.types.join()]),
    ).toEqual([
      ['employee_count', 'number'],
      ['linkedin_url', 'links'],
      ['headquarters', 'address'],
      ['description', 'text'],
      ['industry', 'text'],
      ['founded_year', 'number'],
      ['annual_revenue', 'money'],
      ['total_funding', 'money'],
      ['last_funding_round', 'text'],
      ['last_funding_date', 'date'],
      ['last_funding_amount', 'money'],
      ['monthly_web_visits', 'number'],
    ]);
    expect(company?.fields.find((f) => f.key === 'employee_count')?.create?.universalId).toBe(
      ENRICHMENT.employeeCountField,
    );
    const enrich = manifest.functions.find((f) => f.universalId === ENRICHMENT.enrich);
    expect(enrich).toMatchObject({
      mappedWrite: 'company',
      trigger: {
        binding: 'company',
        fields: ['domain', 'name'],
        related: false,
        operations: ['create', 'update'],
      },
    });
    expect(Object.keys(manifest.settings)).toEqual(['shareLookups']);
    expect(manifest.settings.shareLookups).toMatchObject({ consent: true, required: true });
    expect(manifest.functions.every((fn) => !fn.secrets?.length)).toBe(true);
  });
  it('declares an optional person binding looked up by name, email domain and company', () => {
    const person = manifest.bindings?.find((binding) => binding.key === 'person');
    expect(person).toMatchObject({ required: false, access: 'write', class: 'entity' });
    expect(
      person?.fields.map((field) => [field.key, field.types.join(), !!field.lookup, field.target]),
    ).toEqual([
      ['email', 'emails', true, undefined],
      ['name', 'full_name,text', true, undefined],
      ['company', 'relation', true, 'company'],
      ['job_title', 'text', false, undefined],
      ['headline', 'text', false, undefined],
      ['location', 'text', false, undefined],
      ['seniority', 'text', false, undefined],
      ['department', 'text', false, undefined],
      ['linkedin_url', 'links', false, undefined],
    ]);
    const enrich = manifest.functions.find((f) => f.universalId === ENRICHMENT.enrichPerson);
    expect(enrich).toMatchObject({
      mappedWrite: 'person',
      trigger: {
        binding: 'person',
        fields: ['name', 'email', 'company', 'linkedin_url'],
        related: false,
        operations: ['create', 'update'],
      },
    });
  });
  it('uses the model in configure and the lookups, and not in setup', () => {
    expect(Object.fromEntries(manifest.functions.map((f) => [f.name, f.uses ?? []]))).toEqual({
      configure: ['model'],
      backfill: ['model'],
      backfillPerson: ['model'],
      setup: [],
      enrich: ['model'],
      enrichPerson: ['model'],
    });
  });
});
