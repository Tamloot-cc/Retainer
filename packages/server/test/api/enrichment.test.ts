import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { executeEnrichment } from '@retainer/runner/enrichment';
import { ENRICHMENT, enrichmentManifest } from '@retainer/runner/enrichment-contract';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { answer, fakeAnthropic, type Received, type Upstream } from '../helpers/model.js';

const db = useTestDatabase();
let tokens: RunTokens, broker: SecretBroker, upstream: Upstream;
beforeAll(async () => {
  upstream = await fakeAnthropic();
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'enrichment',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
});

/** A synthetic company search result shaped like Exa's response, with no real company data. */
function exaCompany(
  url: string,
  options: { total?: number | null; hq?: Record<string, string | null> | null; text?: string } = {},
) {
  return {
    requestId: 'fixture',
    results: [
      {
        id: 'https://exa.ai/library/organization/fixture',
        title: 'Fixture Co',
        url,
        text:
          options.text ??
          `# Fixture Co\n\n## Company Details\n- Industry: Software\n- Homepage: ${new URL(url).hostname.replace(/^www\./, '')}\n- LinkedIn: linkedin.com/company/fixture-co\n- Employees: 12`,
        entities: [
          {
            id: 'https://exa.ai/library/organization/fixture',
            type: 'company',
            version: 1,
            properties: {
              name: 'Fixture Co',
              foundedYear: 1970,
              workforce: options.total === null ? null : { total: options.total ?? 12 },
              headquarters:
                options.hq === null
                  ? null
                  : (options.hq ?? {
                      address: 'Springfield, ST, US',
                      city: 'Springfield',
                      postalCode: null,
                      country: 'United States',
                    }),
              financials: null,
              webTraffic: null,
              research: null,
            },
          },
        ],
      },
    ],
    costDollars: { total: 0.008 },
  };
}

/** Answers a Messages request with structured output, as the model would. */
const structured =
  (output: unknown, stopReason = 'end_turn') =>
  (request: Received, res: ServerResponse) =>
    answer(request, res, 'claude-opus-5-5', {
      text: stopReason === 'refusal' ? null : JSON.stringify(output),
      stopReason,
    });
/** The Messages requests that reached the fake Anthropic API, as sent. */
const messages = () =>
  upstream.received
    .filter((r) => r.url === '/v1/messages')
    .map((r) => ({ headers: r.headers, body: JSON.parse(r.body) }));

async function setup(key = 'exa-fixture-key', options: { modelKey?: boolean } = {}) {
  const manifest = enrichmentManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'agent', runtimeEnabled: true }]);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    extensionSecrets: broker,
    model: {
      apiKey: options.modelKey === false ? undefined : 'sk-model-fixture',
      upstream: upstream.origin,
    },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Enrichment ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const stage = await app.request('/v1/extensions/secrets', {
    key: keys.admin,
    body: {
      registrationId: manifest.universalId,
      version: manifest.version,
      name: 'apiKey',
      value: key,
    },
  });
  expect(stage.status).toBe(201);
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings: { shareDomains: true },
    secretRefs: { apiKey: stage.body.pendingSecretId },
    mapping: {
      employee_count: { action: 'create' },
      linkedin_url: { action: 'create' },
      headquarters: { action: 'create' },
    },
  };
  const { mapping: _mapping, ...access } = input;
  const accessPreview = await app.request('/v1/extensions/preview', {
    key: keys.admin,
    body: access,
  });
  const configuring = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...access, planDigest: accessPreview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(configuring.status).toBe(201);
  const finalInput = {
    ...input,
    secretRefs: undefined,
    installationId: configuring.body.id,
    turnOn: true,
  };
  const preview = await app.request('/v1/extensions/preview', {
    key: keys.admin,
    body: finalInput,
  });
  expect(preview.status).toBe(200);
  const installed = await app.request(`/v1/extensions/${configuring.body.id}/turn-on`, {
    key: keys.admin,
    body: { ...finalInput, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(200);
  const id = installed.body.id as string;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);

  /** The fake Exa: answers by path and by the query's domain, its last word. */
  const exa = {
    requests: [] as { path: string; body: Record<string, unknown> | null; key: string | null }[],
    search: (domain: string): Response => Response.json(exaCompany(`https://www.${domain}/`)),
    team: (): Response => Response.json({ object: 'team', id: 'team_fixture', name: 'Fixture' }),
  };
  const apiBodies: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.origin === 'https://api.exa.ai') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      exa.requests.push({
        path: target.pathname,
        body,
        key: new Headers(init?.headers).get('x-api-key'),
      });
      if (target.pathname === '/websets/v0/teams/me') return exa.team();
      expect(target.pathname).toBe('/search');
      return exa.search(String(body.query).split(' ').at(-1) ?? '');
    }
    expect(target.origin).toBe('https://retainer.test');
    if (init?.body && !target.pathname.startsWith('/v1/extensions/runtime/model'))
      apiBodies.push(String(init.body));
    if (failNext && target.pathname.endsWith(failNext.path)) {
      const { after } = failNext;
      failNext = undefined;
      // `after`: the request is served, and only its response is lost.
      if (after) await app.inProcessFetch(url, init);
      return new Response('upstream outage', { status: 502 });
    }
    return app.inProcessFetch(url, init);
  };
  /** Answers the next Retainer API request whose path ends so with a 502 page. */
  let failNext: { path: string; after: boolean } | undefined;
  async function execute(job: ClaimedJob) {
    const token = await tokens.issue(app.sql, job, manifest.universalId, job.scopes);
    const model = job.uses.includes('model')
      ? {
          origin: 'https://retainer.test/v1/extensions/runtime/model',
          token: await tokens.issueModel(job),
        }
      : undefined;
    const result = await executeEnrichment(
      {
        protocolVersion: 1,
        runId: job.jobId,
        attempt: job.attempt,
        installationId: id,
        releaseDigest: job.releaseDigest,
        functionId: job.functionId,
        input: job.input as never,
        apiOrigin: 'https://retainer.test',
        runToken: token,
        deadline: job.deadline.toISOString(),
        ...(model ? { model } : {}),
      },
      new AbortController().signal,
      transport,
    ).catch((error) => ({ status: 'retry' as const, code: String(error.code ?? 'retry') }));
    await queue.complete(job, result);
    return result;
  }
  /** Dispatches changes and runs every due job, returning each result in order. */
  async function drain() {
    await queue.dispatchChanges(workspace.id, id).catch(() => undefined);
    const results = [];
    for (let i = 0; i < 20; i++) {
      const [next] = await db.owner<{ id: string }[]>`
        select id from extension_jobs where installation_id=${id} and status='queued'
          and available_at<=clock_timestamp() order by created_at,id limit 1`;
      if (!next) return results;
      const run = await queue.claim(workspace.id, next.id, 'enrichment-test');
      if (!run) throw new Error('claim failed');
      results.push(await execute(run));
    }
    return results;
  }
  const company = async (values: Record<string, unknown>) => {
    const res = await app.request('/v1/objects/company/records', {
      key: keys.admin,
      body: { values },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const patch = (record: string, values: Record<string, unknown>) =>
    app.request(`/v1/records/${record}`, { key: keys.admin, method: 'PATCH', body: { values } });
  const fields = async (record: string) =>
    (await app.request(`/v1/records/${record}`, { key: keys.admin })).body.fields;
  const detail = async () => (await app.request(`/v1/extensions/${id}`, { key: keys.admin })).body;
  return {
    app,
    keys,
    id,
    exa,
    failNext: (path: string, after = false) => {
      failNext = { path, after };
    },
    apiBodies,
    drain,
    company,
    patch,
    fields,
    detail,
    queue,
    workspace: workspace.id,
  };
}

describe('company enrichment through a fake Exa', () => {
  it('checks the key at setup and fills a new company from its domain', async () => {
    const h = await setup();
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect((await h.detail()).state).toBe('active');
    expect(h.exa.requests).toEqual([
      { path: '/websets/v0/teams/me', body: null, key: 'exa-fixture-key' },
    ]);
    const before = messages().length;
    const acme = await h.company({ name: 'Acme', domain: 'https://www.acme.example/' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(h.exa.requests[1]).toEqual({
      path: '/search',
      key: 'exa-fixture-key',
      body: {
        query: 'Acme acme.example',
        type: 'auto',
        category: 'company',
        numResults: 5,
        contents: { text: { maxCharacters: 4000 } },
      },
    });
    // The one result on the domain settles it without a model call.
    expect(messages()).toHaveLength(before);
    const filled = await h.fields(acme);
    expect(filled.employeeCount).toBe(12);
    // History labels the writes with the extension's name, not its installation ID.
    const actors = await db.owner<{ actor: unknown }[]>`
      select distinct actor from field_assertions where record_id=${acme} and actor->>'type'='agent'`;
    expect(actors.map((a) => a.actor)).toEqual([
      { type: 'agent', id: h.id, name: 'Company-enrichment' },
    ]);
    expect(filled.linkedinUrl).toMatchObject({
      primary: { url: 'https://www.linkedin.com/company/fixture-co' },
    });
    expect(filled.headquarters).toMatchObject({ city: 'Springfield', country: 'United States' });
    expect(filled.headquarters.street1).toBeUndefined();
    // Filling mapped fields starts no lookup of its own.
    expect(await h.drain()).toEqual([]);
    expect(h.exa.requests).toHaveLength(2);
    // Nothing the provider returned is copied into Retainer requests beyond the values.
    expect(h.apiBodies.join('\n')).not.toContain('Fixture Co');
  });

  it('makes no request for a blank domain and enriches once one is added', async () => {
    const h = await setup();
    await h.drain();
    const blank = await h.company({ name: 'No site yet' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_domain' }]);
    expect(h.exa.requests.filter((r) => r.path === '/search')).toEqual([]);
    expect((await h.patch(blank, { name: 'Renamed' })).status).toBe(200);
    expect(await h.drain()).toEqual([]);
    expect((await h.patch(blank, { domain: 'later.example' })).status).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect((await h.fields(blank)).employeeCount).toBe(12);
  });

  it('keeps values people set and skips a company whose fields are all set', async () => {
    const h = await setup();
    await h.drain();
    const set = await h.company({ name: 'Set', domain: 'set.example', employeeCount: 40 });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect((await h.fields(set)).employeeCount).toBe(40);
    const full = await h.company({
      name: 'Full',
      domain: 'full.example',
      employeeCount: 5,
      linkedinUrl: null,
      headquarters: { city: 'Elsewhere' },
    });
    const before = h.exa.requests.length;
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'nothing_to_fill' }]);
    expect(h.exa.requests).toHaveLength(before);
    expect((await h.fields(full)).linkedinUrl).toBeNull();
  });

  it('uses partial results and drops values it cannot read', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) =>
      Response.json(
        exaCompany(`https://${domain}/`, {
          total: null,
          hq: { address: 'Locality only', city: null, postalCode: null, country: 'Israel' },
          text: `## Company Details\n- Homepage: ${domain}\n- LinkedIn: linkedin.com/in/a-person`,
        }),
      );
    const partial = await h.company({ name: 'Partial', domain: 'partial.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    const filled = await h.fields(partial);
    expect(filled.employeeCount).toBeUndefined();
    expect(filled.linkedinUrl).toBeUndefined();
    expect(filled.headquarters).toMatchObject({ country: 'Israel' });
    h.exa.search = (domain) =>
      Response.json(exaCompany(`https://${domain}/`, { total: null, hq: null, text: '' }));
    await h.company({ name: 'Empty', domain: 'empty.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_usable_values' }]);
  });

  it('retries throttling with Exa’s delay and fails malformed responses', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = () =>
      new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '7' } });
    await h.company({ name: 'Busy', domain: 'busy.example' });
    expect(await h.drain()).toEqual([
      { status: 'retry', code: 'provider_rate_limited', retryAfterSeconds: 7 },
    ]);
    const [job] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where installation_id=${h.id} and trigger_kind='change' and status='queued'`;
    if (!job) throw new Error('retry job missing');
    await db.owner`update extension_jobs set available_at=clock_timestamp() where id=${job.id}`;
    h.exa.search = () => new Response('not json', { status: 200 });
    expect(await h.drain()).toEqual([{ status: 'failed', code: 'provider_invalid_response' }]);
    const runs = await h.app.request(`/v1/extensions/${h.id}/runs`, { key: h.keys.admin });
    expect(JSON.stringify(runs.body)).not.toContain('busy.example');
  });

  it('asks for a reconnect when Exa rejects the key, and reports exhausted credits', async () => {
    const rejected = await setup('bad-key');
    rejected.exa.team = () => new Response('{}', { status: 401 });
    rejected.exa.search = () => new Response('{}', { status: 401 });
    expect(await rejected.drain()).toEqual([{ status: 'failed', code: 'provider_unauthorized' }]);
    expect(rejected.exa.requests.map((r) => r.path)).toEqual(['/websets/v0/teams/me', '/search']);
    expect(await rejected.detail()).toMatchObject({
      state: 'setup_failed',
      connectionHealth: 'needs_reconnect',
    });
    const broke = await setup();
    broke.exa.team = () => new Response('{}', { status: 402 });
    expect(await broke.drain()).toEqual([{ status: 'failed', code: 'provider_payment_required' }]);
    expect((await broke.detail()).connectionHealth).toBe('degraded');
  });

  it('falls back to a search when the team-info path is not available', async () => {
    const h = await setup();
    h.exa.team = () => new Response('{}', { status: 404 });
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect(h.exa.requests.map((r) => r.path)).toEqual(['/websets/v0/teams/me', '/search']);
    expect(h.exa.requests[1]?.body?.query).toBe('exa.ai');
  });

  it('accepts a key whose team cannot use Websets when search works', async () => {
    const h = await setup();
    // What Exa returns to a team that is not on a Pro plan.
    h.exa.team = () =>
      new Response(
        JSON.stringify({ statusCode: 401, message: 'Your team does not have access to the API.' }),
        { status: 401 },
      );
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect((await h.detail()).state).toBe('active');
    expect(h.exa.requests.map((r) => r.path)).toEqual(['/websets/v0/teams/me', '/search']);
  });

  it('fails a run whose mapped field was deleted, without calling Exa', async () => {
    const h = await setup();
    await h.drain();
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    await db.owner`delete from extension_contributions where installation_id=${h.id} and universal_id=${ENRICHMENT.headquartersField}`;
    expect(
      (
        await h.app.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: { operations: [{ op: 'delete_field', object: 'company', field: 'headquarters' }] },
        })
      ).status,
    ).toBe(200);
    const before = h.exa.requests.length;
    expect(await h.drain()).toEqual([{ status: 'failed', code: 'schema_binding_conflict' }]);
    expect(h.exa.requests).toHaveLength(before);
    expect((await h.fields(acme)).employeeCount).toBeUndefined();
  });
});

describe('picking the company with the model (model calls spec 6.3-6.5)', () => {
  /** Two results, neither settled by the shortcut: a redirect and another company. */
  const twoResults = (
    first: string,
    firstHomepage: string,
    second = 'https://acme-labs.example/',
  ) =>
    Response.json({
      results: [
        exaCompany(first, {
          text: `## Company Details\n- Homepage: ${firstHomepage}\n- LinkedIn: linkedin.com/company/fixture-co`,
        }).results[0],
        exaCompany(second).results[0],
      ],
    });

  it('applies a medium pick on the domain at 0.7, and holds it where the threshold is higher', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'medium' }));
    const before = messages().length;
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_medium' }]);
    expect((await h.fields(acme)).employeeCount).toBe(12);
    const [row] = await db.owner<{ confidence: number }[]>`
      select a.confidence from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='employeeCount'`;
    expect(row?.confidence).toBeCloseTo(0.7);
    const [sent] = messages().slice(before);
    expect(sent?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      fallbacks: 'default',
      output_config: { effort: 'low' },
    });
    expect(sent?.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(sent?.body.messages[0].content).toContain('<profiles>');

    await db.owner`update workspaces set settings = settings || '{"confidenceThreshold":0.8}'::jsonb
      where id=${h.workspace}`;
    const held = await h.company({ name: 'Held', domain: 'held.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_medium' }]);
    expect((await h.fields(held)).employeeCount).toBeUndefined();
    const pending = await db.owner<{ n: number }[]>`
      select count(*)::int as n from field_assertions where record_id=${held} and status='pending_review'`;
    expect(pending[0]?.n).toBeGreaterThan(0);
  });

  it('accepts a pick on another domain only at high with the same name', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = () => twoResults('https://fixture.example/', 'fixture.example');
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const renamed = await h.company({ name: 'Fixture Co.', domain: 'old-fixture.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_high' }]);
    expect((await h.fields(renamed)).employeeCount).toBe(12);
    const other = await h.company({ name: 'Someone Else', domain: 'else.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match_model' }]);
    upstream.respond(structured({ index: 0, certainty: 'medium' }));
    const medium = await h.company({ name: 'Fixture Co', domain: 'medium.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match_model' }]);
    for (const record of [other, medium])
      expect((await h.fields(record)).employeeCount).toBeUndefined();
  });

  it.each([
    ['a refusal', structured(null, 'refusal'), 'no_match_model_refused'],
    ['output cut off', structured({ index: 0 }, 'max_tokens'), 'no_match_model_output'],
    ['no company', structured({ index: null, certainty: 'high' }), 'no_match_model'],
  ])('writes nothing after %s', async (_case, respond, code) => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(respond);
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code }]);
    expect((await h.fields(acme)).employeeCount).toBeUndefined();
  });

  it('does not look a company up again when it only gets a name', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = () => twoResults('https://fixture.example/', 'fixture.example');
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const unnamed = await h.company({ domain: 'old-fixture.example' });
    // No name: a pick on another domain can't be accepted.
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match_model' }]);
    // The trigger watches the domain only (spec 6.7): the base name field can
    // be deleted, and a trigger on a deleted field would stop all dispatch.
    expect((await h.patch(unnamed, { name: 'Fixture Co' })).status).toBe(200);
    expect(await h.drain()).toEqual([]);
  });

  it('clears the pick when the write committed but its response was lost', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    h.failNext('/runtime/mapped-writes', true);
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'retry', code: 'api_unavailable' }]);
    expect((await h.fields(acme)).employeeCount).toBe(12);
    await db.owner`update extension_jobs set available_at=clock_timestamp() where installation_id=${h.id} and status='queued'`;
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'nothing_to_fill' }]);
    const [left] = await db.owner<{ value: unknown }[]>`
      select value from extension_kv where installation_id=${h.id} and key=${`pick:${acme}:acme.example`}`;
    expect(left?.value).toEqual({});
  });

  it('clears the pick when a backfill write committed but its response was lost', async () => {
    const h = await setup();
    await h.drain();
    // Enriched first with headquarters only, so the backfill has outputs to fill.
    h.exa.search = (domain) => Response.json(exaCompany(`https://${domain}/`, { total: null }));
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    h.failNext('/runtime/mapped-writes', true);
    await h.queue.enqueue(h.workspace, h.id, {
      functionId: ENRICHMENT.backfill,
      input: {},
      dedupeKey: randomUUID(),
    });
    expect(await h.drain()).toEqual([{ status: 'retry', code: 'api_unavailable' }]);
    expect((await h.fields(acme)).employeeCount).toBe(12);
    await db.owner`update extension_jobs set available_at=clock_timestamp() where installation_id=${h.id} and status='queued'`;
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'backfill_page' }]);
    const [left] = await db.owner<{ value: unknown }[]>`
      select value from extension_kv where installation_id=${h.id} and key=${`pick:${acme}:acme.example`}`;
    expect(left?.value).toEqual({});
  });

  it('backfills a company whose first values are still held for review', async () => {
    const h = await setup();
    await h.drain();
    await db.owner`update workspaces set settings = settings || '{"confidenceThreshold":0.8}'::jsonb
      where id=${h.workspace}`;
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'medium' }));
    await h.company({ name: 'Held', domain: 'held.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_medium' }]);
    const before = h.exa.requests.length;
    await h.queue.enqueue(h.workspace, h.id, {
      functionId: ENRICHMENT.backfill,
      input: {},
      dedupeKey: randomUUID(),
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'backfill_page' }]);
    expect(
      h.exa.requests
        .slice(before)
        .filter((r) => r.path === '/search')
        .map((r) => r.body?.query),
    ).toEqual(['Held held.example']);
  });

  it('ends without a match when the server has no model key', async () => {
    const h = await setup('exa-fixture-key', { modelKey: false });
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match_model_unavailable' }]);
    expect((await h.fields(acme)).employeeCount).toBeUndefined();
    // A result on the domain still matches without the model.
    h.exa.search = (domain) => Response.json(exaCompany(`https://${domain}/`));
    await h.company({ name: 'Direct', domain: 'direct.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
  });

  it('reuses the stored pick when the run retries after the model call, clears it once written, and erasure removes it', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const before = messages().length;
    h.failNext('/runtime/mapped-writes');
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'retry', code: 'api_unavailable' }]);
    const key = `pick:${acme}:acme.example`;
    const [stored] = await db.owner<{ value: Record<string, unknown> }[]>`
      select value from extension_kv where installation_id=${h.id} and key=${key}`;
    expect(stored?.value).toMatchObject({
      candidateUrl: 'https://redirect.example/',
      certainty: 'high',
    });
    await db.owner`update extension_jobs set available_at=clock_timestamp() where installation_id=${h.id} and status='queued'`;
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_high' }]);
    expect(messages()).toHaveLength(before + 1);
    expect((await h.fields(acme)).employeeCount).toBe(12);
    // Written, so the pick is cleared and takes no room in the KV quota.
    const [cleared] = await db.owner<{ value: unknown }[]>`
      select value from extension_kv where installation_id=${h.id} and key=${key}`;
    expect(cleared?.value).toEqual({});
    expect(
      (await h.app.request(`/v1/records/${acme}/forget`, { key: h.keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      await db.owner`select 1 from extension_kv where installation_id=${h.id} and key=${key}`,
    ).toHaveLength(0);
  });
});

describe('enrichment configure and backfill', () => {
  const requestSuggestions = async (h: Awaited<ReturnType<typeof setup>>) => {
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/configure`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(202);
    const results = await h.drain();
    const saved = await h.app.request(`/v1/extensions/${h.id}/suggestions`, { key: h.keys.admin });
    expect(saved.body.status).toBe('ready');
    return { results, mapping: saved.body.mapping };
  };

  it('suggests the mapping with the model, from sampled companies and the current mapping', async () => {
    const h = await setup();
    await h.drain();
    await h.company({ name: 'Sampled', domain: 'sampled.example', employeeCount: 340 });
    await h.drain();
    upstream.respond(
      structured({
        employee_count: {
          action: 'existing',
          field: 'employeeCount',
          reason: 'It holds head counts.',
        },
        linkedin_url: { action: 'skip', field: null, reason: 'Not wanted.' },
        headquarters: { action: 'existing', field: 'headquarters', reason: 'Same meaning.' },
      }),
    );
    const before = messages().length;
    const { results, mapping } = await requestSuggestions(h);
    expect(results).toEqual([{ status: 'succeeded', code: 'suggestions_ready' }]);
    expect(mapping.employee_count).toMatchObject({
      action: 'existing',
      field: 'employeeCount',
      reason: 'It holds head counts.',
    });
    expect(mapping.linkedin_url).toMatchObject({ action: 'skip', reason: 'Not wanted.' });
    const [sent] = messages().slice(before);
    // Through the proxy: Retainer's key in place of the model token.
    expect(sent?.headers['x-api-key']).toBe('sk-model-fixture');
    expect(sent?.headers.authorization).toBeUndefined();
    const prompt = JSON.parse(sent?.body.messages[0].content);
    expect(
      prompt.companyFields.find((f: { name: string }) => f.name === 'employeeCount').samples,
    ).toContain(340);
    expect(prompt.currentMapping.employee_count).toEqual({
      action: 'existing',
      field: 'employeeCount',
    });
    const usage = await db.owner<{ function_id: string; model: string }[]>`
      select function_id,model from ai_usage where installation_id=${h.id}`;
    expect(usage).toEqual([{ function_id: ENRICHMENT.configure, model: 'claude-opus-5-5' }]);
  });

  it('falls back to API-name suggestions when the server has no model key', async () => {
    const h = await setup('exa-fixture-key', { modelKey: false });
    await h.drain();
    const { results, mapping } = await requestSuggestions(h);
    expect(results).toEqual([{ status: 'succeeded', code: 'suggestions_ready_without_model' }]);
    expect(mapping.employee_count).toMatchObject({ action: 'existing', field: 'employeeCount' });
    expect(mapping.linkedin_url).toMatchObject({ action: 'existing', field: 'linkedinUrl' });
  });

  it('backfills only previously enriched companies and preserves filled values', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => Response.json(exaCompany(`https://${domain}`, { hq: null }));
    const company = await h.company({ name: 'Existing', domain: 'https://existing.example' });
    await h.drain();
    h.exa.search = () => Response.json({ results: [] });
    const unmatched = await h.company({ name: 'Unmatched', domain: 'https://unmatched.example' });
    await h.drain();
    const before = h.exa.requests.length;
    h.exa.search = (domain) =>
      Response.json(
        exaCompany(`https://${domain}`, { total: 999, hq: { city: 'Austin', country: 'US' } }),
      );
    await h.queue.enqueue(h.workspace, h.id, {
      functionId: ENRICHMENT.backfill,
      input: {},
      dedupeKey: randomUUID(),
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'backfill_page' }]);
    expect((await h.fields(company)).employeeCount).toBe(12);
    expect((await h.fields(company)).headquarters.city).toBe('Austin');
    expect((await h.fields(unmatched)).employeeCount).toBeUndefined();
    expect(
      h.exa.requests
        .slice(before)
        .filter((r) => r.path === '/search')
        .map((r) => r.body?.query),
    ).toEqual(['Existing existing.example']);
  });
});
