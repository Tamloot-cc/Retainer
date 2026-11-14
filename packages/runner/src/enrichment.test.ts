import type { Invocation } from '@retainer/extension';
import { RetainerClient } from '@retainer/sdk';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { executeEnrichment, lookUp, MEDIUM_CONFIDENCE, PICK_TTL_MS } from './enrichment.js';
import {
  ENRICHMENT,
  ENRICHMENT_MODEL,
  enrichmentManifest,
  exaSearchRequest,
} from './enrichment-contract.js';
import { enrichmentModel } from './enrichment-model.js';
import {
  acceptPick,
  type Candidate,
  candidateValues,
  companyCandidates,
  ExaProvider,
  normalizeCompanyName,
  shortcut,
} from './enrichment-provider.js';

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

/** A run against fakes: Exa, the model proxy and the Retainer API's KV. */
function fakes(
  results: unknown[],
  answer: Answer = () => message({ index: 0, certainty: 'high' }),
) {
  const kv = new Map<string, { value: unknown; revision: number }>();
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
    const kvPath = /\/runtime\/kv\/(.+)$/.exec(target.pathname);
    if (kvPath) return json(kv.get(decodeURIComponent(kvPath[1] ?? '')) ?? null);
    if (target.pathname.endsWith('/runtime/checkpoint')) {
      const prior = kv.get(body.kv.key);
      if ((prior?.revision ?? null) !== body.kv.expectedRevision)
        return json({ error: { code: 'revision_conflict', message: 'conflict' } }, 409);
      const revision = (prior?.revision ?? 0) + 1;
      kv.set(body.kv.key, { value: body.kv.value, revision });
      return json({ ids: [], revision });
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
    model: () => enrichmentModel(invocation, transport)?.withOptions({ maxRetries: 0 }) ?? null,
    signal,
  };
  const record = {
    id: 'record-1',
    name: 'Acme',
    domain: 'acme.example',
    context: { employee_count: 40 },
  };
  return { kv, calls, run, record };
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
      model: 'claude-opus-5-5',
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

  it('reuses a stored pick on a retry, and ignores one older than seven days', async () => {
    const f = fakes([result('https://acme.example.org/')]);
    await lookUp(f.run, f.record);
    expect(f.calls.model).toHaveLength(1);
    const stored = f.kv.get('pick:record-1:acme.example');
    expect(stored?.value).toMatchObject({
      candidateUrl: 'https://acme.example.org/',
      certainty: 'high',
    });
    expect(await lookUp(f.run, f.record)).toMatchObject({ code: 'matched_model_high' });
    expect(f.calls.model).toHaveLength(1);
    f.kv.set('pick:record-1:acme.example', {
      revision: stored?.revision ?? 1,
      value: {
        candidateUrl: 'https://acme.example.org/',
        certainty: 'high',
        at: new Date(Date.now() - PICK_TTL_MS - 1000).toISOString(),
      },
    });
    await lookUp(f.run, f.record);
    expect(f.calls.model).toHaveLength(2);
    expect(f.kv.get('pick:record-1:acme.example')?.revision).toBe(2);
  });

  it('calls the model again when the stored pick is not among the candidates', async () => {
    const f = fakes([result('https://acme.example.org/')]);
    f.kv.set('pick:record-1:acme.example', {
      revision: 1,
      value: {
        candidateUrl: 'https://gone.example/',
        certainty: 'high',
        at: new Date().toISOString(),
      },
    });
    await lookUp(f.run, f.record);
    expect(f.calls.model).toHaveLength(1);
  });
});

describe('configure (spec 6.1)', () => {
  const schema = {
    objects: [
      {
        nameSingular: 'company',
        baseObject: 'company',
        labelField: 'name',
        fields: [
          { name: 'name', label: 'Name', type: 'text', readOnly: false, description: null },
          {
            name: 'domain',
            label: 'Domain',
            type: 'links',
            readOnly: false,
            baseField: 'companyDomain',
            description: null,
          },
          { name: 'size', label: 'Size', type: 'number', readOnly: false, description: null },
          {
            name: 'dealSize',
            label: 'Deal size',
            type: 'number',
            readOnly: false,
            description: null,
          },
          {
            name: 'linkedinUrl',
            label: 'LinkedIn',
            type: 'links',
            readOnly: false,
            description: null,
          },
          { name: 'score', label: 'Score', type: 'number', readOnly: true, description: null },
        ],
      },
    ],
  };
  function configure(answer: Answer, reason = 'install') {
    const saved: unknown[] = [];
    const prompts: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (target.origin === 'https://api.exa.ai') return json({ id: 'team' });
      if (target.origin === 'https://model.test') {
        prompts.push(JSON.stringify(body));
        return answer({ body });
      }
      if (target.pathname.endsWith('/runtime/secrets/apiKey'))
        return json({ value: 'k', revision: 1 });
      if (target.pathname === '/v1/schema') return json(schema);
      if (target.pathname === '/v1/objects/company/query')
        return json({
          records: [
            { id: 'a', fields: { size: 12, dealSize: 50000, linkedinUrl: null } },
            { id: 'b', fields: { size: 340, dealSize: 9000 } },
          ],
          nextCursor: null,
        });
      if (target.pathname === '/v1/extensions/installation')
        return json({
          mapping: {
            revision: 1,
            outputs: [{ output: 'employee_count', action: 'existing', field: { name: 'size' } }],
          },
        });
      if (target.pathname.endsWith('/runtime/suggestions')) {
        saved.push(body);
        return json({ saved: true });
      }
      throw new Error(`unexpected request ${target}`);
    };
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
      run: () => executeEnrichment(invocation, new AbortController().signal, transport),
    };
  }
  const choice = (action: string, field: string | null, reason = 'Because.') => ({
    action,
    field,
    reason,
  });

  it('saves the model’s choices, sampling compatible fields only', async () => {
    const c = configure(() =>
      message({
        employee_count: choice('existing', 'size'),
        linkedin_url: choice('create', null),
        headquarters: choice('skip', null),
      }),
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved).toEqual([
      {
        mapping: {
          employee_count: { action: 'existing', field: 'size', reason: 'Because.' },
          linkedin_url: { action: 'create', reason: 'Because.' },
          headquarters: { action: 'skip', reason: 'Because.' },
        },
      },
    ]);
    const sent = JSON.parse(JSON.parse(c.prompts[0] ?? '{}').messages[0].content);
    // Read-only fields, the lookup field and incompatible types are never offered.
    expect(sent.companyFields.map((f: { name: string }) => [f.name, f.samples])).toEqual([
      ['size', [12, 340]],
      ['dealSize', [50000, 9000]],
      ['linkedinUrl', []],
    ]);
    expect(sent.outputs.map((o: { key: string }) => o.key)).toEqual([
      'employee_count',
      'linkedin_url',
      'headquarters',
    ]);
    expect(sent.currentMapping).toBeUndefined();
  });

  it('sends the current mapping on a request and keeps name-and-type for a choice that cannot fit', async () => {
    const c = configure(
      () =>
        message({
          employee_count: choice('existing', 'score'),
          linkedin_url: choice('existing', 'size'),
          headquarters: choice('existing', 'missing'),
        }),
      'requested',
    );
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready' });
    expect(c.saved[0]).toMatchObject({
      mapping: {
        employee_count: { action: 'create' },
        linkedin_url: { action: 'existing', field: 'linkedinUrl' },
        headquarters: { action: 'create' },
      },
    });
    expect(c.prompts[0]).toContain('currentMapping');
  });

  it.each([
    [
      'the proxy has no key',
      () => json({ type: 'error', error: { type: 'model_unavailable', message: 'x' } }, 503),
    ],
    ['the model refuses', () => message(null, 'refusal')],
    ['the output does not parse', () => message({ employee_count: 'size' })],
    [
      'the provider is down',
      () => json({ type: 'error', error: { type: 'x', message: 'x' } }, 500),
    ],
  ])('falls back to name-and-type suggestions when %s', async (_case, answer) => {
    const c = configure(answer);
    expect(await c.run()).toEqual({ status: 'succeeded', code: 'suggestions_ready_without_model' });
    expect(c.saved).toEqual([
      {
        mapping: {
          employee_count: { action: 'create', reason: expect.any(String) },
          linkedin_url: { action: 'existing', field: 'linkedinUrl', reason: expect.any(String) },
          headquarters: { action: 'create', reason: expect.any(String) },
        },
      },
    ]);
  });
});

describe('enrichment manifest', () => {
  const manifest = enrichmentManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  it('declares the reviewed outputs, the domain lookup and a narrow mapped-write trigger', () => {
    expect(manifest.requestedActor).toBe('agent');
    expect(manifest.mapping?.objectId).toBe(BASE_OBJECT_IDS.company);
    expect(manifest.mapping?.outputs.map((o) => [o.key, o.types, o.field?.universalId])).toEqual([
      ['employee_count', ['number'], ENRICHMENT.employeeCountField],
      ['linkedin_url', ['links'], ENRICHMENT.linkedinField],
      ['headquarters', ['address'], ENRICHMENT.headquartersField],
    ]);
    const enrich = manifest.functions.find((f) => f.universalId === ENRICHMENT.enrich);
    expect(enrich).toMatchObject({
      mappedWrite: true,
      secrets: ['apiKey'],
      trigger: {
        fieldIds: [ENRICHMENT.domainField],
        related: false,
        operations: ['create', 'update'],
      },
    });
    expect(manifest.settings.shareDomains).toMatchObject({ consent: true, required: true });
  });
  it('uses the model in configure and the lookups, and not in setup', () => {
    expect(Object.fromEntries(manifest.functions.map((f) => [f.name, f.uses ?? []]))).toEqual({
      configure: ['model'],
      backfill: ['model'],
      setup: [],
      enrich: ['model'],
    });
  });
});
