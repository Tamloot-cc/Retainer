import { randomBytes, randomUUID } from 'node:crypto';
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

const db = useTestDatabase();
let tokens: RunTokens, broker: SecretBroker;
beforeAll(async () => {
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

async function setup(key = 'exa-fixture-key') {
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
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);

  /** The fake Exa: answers by path, records each request without its key. */
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
      return exa.search(body.query);
    }
    expect(target.origin).toBe('https://retainer.test');
    if (init?.body) apiBodies.push(String(init.body));
    return app.inProcessFetch(url, init);
  };
  async function execute(job: ClaimedJob) {
    const token = await tokens.issue(app.sql, job, manifest.universalId, job.scopes);
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
  return { app, keys, id, exa, apiBodies, drain, company, patch, fields, detail };
}

describe('company enrichment through a fake Exa', () => {
  it('checks the key at setup and fills a new company from its domain', async () => {
    const h = await setup();
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect((await h.detail()).state).toBe('active');
    expect(h.exa.requests).toEqual([
      { path: '/websets/v0/teams/me', body: null, key: 'exa-fixture-key' },
    ]);
    const acme = await h.company({ name: 'Acme', domain: 'https://www.acme.example/' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'applied' }]);
    expect(h.exa.requests[1]).toEqual({
      path: '/search',
      key: 'exa-fixture-key',
      body: {
        query: 'acme.example',
        type: 'auto',
        category: 'company',
        includeDomains: ['acme.example'],
        numResults: 1,
        contents: { text: { maxCharacters: 4000 } },
      },
    });
    const filled = await h.fields(acme);
    expect(filled.employeeCount).toBe(12);
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
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'applied' }]);
    expect((await h.fields(blank)).employeeCount).toBe(12);
  });

  it('keeps values people set and skips a company whose fields are all set', async () => {
    const h = await setup();
    await h.drain();
    const set = await h.company({ name: 'Set', domain: 'set.example', employeeCount: 40 });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'applied' }]);
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

  it('writes nothing when Exa returns another domain or a contradicting homepage', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = () => Response.json(exaCompany('https://other.example/'));
    const a = await h.company({ name: 'A', domain: 'a.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match' }]);
    h.exa.search = () =>
      Response.json(
        exaCompany('https://b.example/', { text: '## Company Details\n- Homepage: other.example' }),
      );
    const b = await h.company({ name: 'B', domain: 'b.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match' }]);
    for (const record of [a, b]) expect((await h.fields(record)).employeeCount).toBeUndefined();
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
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'applied' }]);
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
