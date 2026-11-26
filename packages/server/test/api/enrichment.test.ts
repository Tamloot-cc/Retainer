import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { executeEnrichment } from '@retainer/runner/enrichment';
import {
  COMPANY_OUTPUTS,
  ENRICHMENT,
  enrichmentManifest,
} from '@retainer/runner/enrichment-contract';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireAnswer } from '../../../runner/src/binding-suggestions-test-fixture.js';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { answer, fakeAnthropic, type Received, type Upstream } from '../helpers/model.js';

const db = useTestDatabase();
let tokens: RunTokens, upstream: Upstream;
beforeAll(async () => {
  upstream = await fakeAnthropic();
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'enrichment',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});

beforeEach(() => vi.stubEnv('EXA_API_KEY', 'exa-fixture-key'));
afterEach(() => vi.unstubAllEnvs());

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

/** A synthetic people search result shaped like Exa's response, with no real person data. */
function exaPerson(company: string) {
  return {
    requestId: 'fixture',
    results: [
      {
        id: 'https://exa.ai/library/person/fixture',
        title: 'Ada Example',
        url: 'https://linkedin.com/in/ada-example-fixture',
        text: `# Ada Example\n\nFounder at ${company}\n\nSpringfield, United States (US)\n\n## Experience\n\n### CEO - [${company}](https://www.linkedin.com/company/fixture-co) (Current)\n\nDepartment: General Management • Level: C-Level\n`,
        entities: [
          {
            id: 'https://exa.ai/library/person/fixture',
            type: 'person',
            version: 1,
            properties: {
              name: 'Ada Example',
              firstName: 'Ada',
              lastName: 'Example',
              location: 'Springfield, United States',
              workHistory: [
                {
                  title: 'CEO',
                  location: null,
                  dates: { from: '2020-01-01', to: null },
                  company: { id: null, name: company },
                },
              ],
              educationHistory: [],
              research: null,
            },
          },
        ],
      },
    ],
  };
}

/** Answers a Messages request with structured output, as the model would. */
const structured =
  (output: unknown, stopReason = 'end_turn') =>
  (request: Received, res: ServerResponse) =>
    answer(request, res, 'claude-haiku-5-5', {
      text: stopReason === 'refusal' ? null : JSON.stringify(wireAnswer(output)),
      stopReason,
    });
/** The Messages requests that reached the fake Anthropic API, as sent. */
const messages = () =>
  upstream.received
    .filter((r) => r.url === '/v1/messages')
    .map((r) => ({ headers: r.headers, body: JSON.parse(r.body) }));

/** The original three outputs are created; the later ones are skipped unless a test maps them. */
const companyFields = Object.fromEntries(
  COMPANY_OUTPUTS.map((output) => [
    output.key,
    ['employee_count', 'linkedin_url', 'headquarters'].includes(output.key)
      ? { action: 'create' }
      : { action: 'skip' },
  ]),
);

async function setup(
  options: {
    modelKey?: boolean;
    legacy?: boolean;
    person?: Record<string, unknown>;
    company?: Record<string, unknown>;
  } = {},
) {
  const manifest = enrichmentManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const legacy = {
    ...manifest,
    version: '1.0.0',
    settings: {
      ...manifest.settings,
      apiKey: {
        type: 'string' as const,
        label: 'Exa API key',
        secret: true,
        required: true,
        reconnect: true,
      },
    },
    functions: manifest.functions
      .filter((fn) => fn.trigger.kind !== 'recordButton')
      .map((fn) => ({ ...fn, secrets: ['apiKey'] })),
  };
  const current = { ...manifest, version: '1.0.1' };
  const catalog = new ExtensionCatalog(
    (options.legacy ? [legacy, current] : [current]).map((release) => ({
      manifest: release,
      actorCeiling: 'agent',
      runtimeEnabled: true,
    })),
  );
  const extensionSecrets = options.legacy
    ? new SecretBroker(
        db.connect({ role: 'retainer_secret_broker' }),
        new SecretCipher('test', new Map([['test', randomBytes(32)]])),
      )
    : undefined;
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    extensionSecrets,
    model: {
      apiKey: options.modelKey === false ? undefined : 'sk-model-fixture',
      upstream: upstream.origin,
    },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Enrichment ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      writer: { actor: { type: 'user', id: 'writer' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'reader' }, scopes: ['read'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['read', 'write'] },
    },
  );
  let secretRefs: { apiKey: string } | undefined;
  if (options.legacy) {
    const staged = await app.request('/v1/extensions/secrets', {
      key: keys.admin,
      body: {
        registrationId: legacy.universalId,
        version: legacy.version,
        name: 'apiKey',
        value: 'legacy-workspace-key',
      },
    });
    expect(staged.status).toBe(201);
    secretRefs = { apiKey: staged.body.pendingSecretId };
  }
  const input = {
    registrationId: current.universalId,
    version: options.legacy ? legacy.version : current.version,
    settings: { shareLookups: true },
    bindings: {
      company: {
        action: 'existing',
        objects: ['company'],
        fields: { ...companyFields, ...options.company },
      },
      person: options.person ?? { action: 'skip' },
    },
  };
  const { bindings: _bindings, ...access } = { ...input, secretRefs };
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
  const legacyDigest = options.legacy
    ? catalog.get(legacy.universalId, legacy.version).digest
    : null;

  /** The fake Exa: answers by path and by the query's domain, its last word. */
  const exa = {
    requests: [] as { path: string; body: Record<string, unknown> | null; key: string | null }[],
    search: (domain: string): Response => Response.json(exaCompany(`https://www.${domain}/`)),
    people: (_query: string): Response | Promise<Response> =>
      Response.json(exaPerson('Fixture Co')),
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
      if (body.category === 'people') return exa.people(String(body.query));
      return exa.search(String(body.query).split(' ').at(-1) ?? '');
    }
    expect(target.origin).toBe('https://retainer.test');
    expect(target.pathname).not.toContain('/runtime/secrets/');
    if (init?.body && !target.pathname.startsWith('/v1/extensions/runtime/model'))
      apiBodies.push(String(init.body));
    if (failNext && target.pathname.endsWith(failNext)) {
      failNext = undefined;
      return new Response('upstream outage', { status: 502 });
    }
    return app.inProcessFetch(url, init);
  };
  /** Answers the next Retainer API request whose path ends so with a 502 page. */
  let failNext: string | undefined;
  async function execute(job: ClaimedJob) {
    // The old release runs its own code in production. Complete its one setup
    // job so the test can exercise the supported upgrade from an active install.
    if (job.releaseDigest === legacyDigest) {
      expect(job.functionId).toBe(ENRICHMENT.setup);
      const result = { status: 'succeeded' as const };
      await queue.complete(job, result);
      return result;
    }
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
  const person = async (values: Record<string, unknown>) => {
    const res = await app.request('/v1/objects/person/records', {
      key: keys.admin,
      body: { values },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const patch = (record: string, values: Record<string, unknown>) =>
    app.request(`/v1/records/${record}`, { key: keys.admin, method: 'PATCH', body: { values } });
  const fields = async (record: string) =>
    (await app.request(`/v1/records/${record}`, { key: keys.admin })).body.fields;
  const detail = async () => (await app.request(`/v1/extensions/${id}`, { key: keys.admin })).body;
  /** The current release's input for upgrading this installation. */
  const upgradeInput = {
    registrationId: ENRICHMENT.registration,
    version: current.version,
    installationId: id,
    settings: { shareLookups: true },
  };
  /** Previews and approves the upgrade to the current release, as an admin reviewing it. */
  async function upgrade() {
    const preview = await app.request('/v1/extensions/preview', {
      key: keys.admin,
      body: upgradeInput,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const upgraded = await app.request(`/v1/extensions/${id}/upgrade`, {
      key: keys.admin,
      body: { ...upgradeInput, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
  }
  return {
    upgradeInput,
    upgrade,
    app,
    keys,
    id,
    exa,
    failNext: (path: string) => {
      failNext = path;
    },
    apiBodies,
    drain,
    company,
    person,
    patch,
    fields,
    detail,
    queue,
    workspace: workspace.id,
    currentVersion: current.version,
  };
}

describe('Exa enrichment through a fake Exa', () => {
  it('checks the key at setup and fills a new company from its domain', async () => {
    const h = await setup();
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect(await h.detail()).toMatchObject({ state: 'active', secrets: {} });
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
    // The output fields the install created carry the bundle's descriptions.
    const names = COMPANY_OUTPUTS.map((output) => output.field.name);
    const created = await db.owner<{ name: string; description: string | null }[]>`
      select f.name, f.description from fields f join object_types o on o.id=f.object_type_id
      where f.workspace_id=${h.workspace} and o.name_singular='company' and f.name in ${db.owner(names)}`;
    expect(created.length).toBeGreaterThan(0);
    for (const field of created)
      expect(field.description).toBe(
        COMPANY_OUTPUTS.find((output) => output.field.name === field.name)?.description,
      );
    // History labels the writes with the extension's name, not its installation ID.
    const actors = await db.owner<{ actor: unknown }[]>`
      select distinct actor from field_assertions where record_id=${acme} and actor->>'type'='agent'`;
    expect(actors.map((a) => a.actor)).toEqual([
      { type: 'agent', id: h.id, name: 'Exa-enrichment' },
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

  it('runs a company button after an automatic miss and coalesces concurrent presses', async () => {
    const h = await setup();
    const acme = await h.company({
      name: 'Acme',
      domain: 'acme.example',
      employeeCount: 42,
    });
    const list = (object: string) =>
      h.app.request(`/v1/extensions/record-buttons?object=${object}`, { key: h.keys.writer });
    const path = `/v1/extensions/${h.id}/record-buttons`;
    const press = (functionId: string, recordId = acme, key = h.keys.writer) =>
      h.app.request(`${path}/${functionId}`, { key, body: { recordId } });

    expect((await list('company')).body.buttons).toEqual([]);
    expect((await press(ENRICHMENT.enrichCompanyNow)).status).toBe(409);
    await h.drain();
    const search = h.exa.search;
    h.exa.search = () => Response.json({ results: [] });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match' }]);
    expect((await h.fields(acme)).headquarters).toBeUndefined();
    h.exa.search = search;
    expect(h.exa.requests).toHaveLength(2);
    expect((await list('companies')).body.buttons).toEqual([
      { installationId: h.id, functionId: ENRICHMENT.enrichCompanyNow, label: 'Enrich now' },
    ]);
    expect((await list('person')).body.buttons).toEqual([]);
    expect((await press(ENRICHMENT.enrichCompanyNow, acme, h.keys.reader)).status).toBe(403);
    expect((await press(ENRICHMENT.enrichCompanyNow, acme, h.keys.agent)).status).toBe(403);
    expect((await press(ENRICHMENT.enrich)).status).toBe(404);
    const person = await h.person({ name: { first: 'Ada', last: 'Example' } });
    expect((await press(ENRICHMENT.enrichCompanyNow, person)).status).toBe(404);
    expect((await press(ENRICHMENT.enrichPersonNow, person)).status).toBe(404);
    expect((await press(ENRICHMENT.enrichCompanyNow, randomUUID())).status).toBe(404);

    const [first, second] = await Promise.all([
      press(ENRICHMENT.enrichCompanyNow),
      press(ENRICHMENT.enrichCompanyNow, acme.toUpperCase()),
    ]);
    expect(first.status).toBe(202);
    expect(second).toMatchObject({ status: 202, body: first.body });
    const statusPath = `/v1/extensions/${h.id}/record-button-runs/${first.body.id}`;
    expect((await h.app.request(statusPath, { key: h.keys.writer })).body.status).toBe('queued');
    expect(await h.queue.discover(db.connect({ role: 'retainer_executor' }))).toContainEqual({
      workspace_id: h.workspace,
      job_id: first.body.id,
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(await h.fields(acme)).toMatchObject({
      employeeCount: 42,
      headquarters: { city: 'Springfield' },
    });
    expect(h.exa.requests).toHaveLength(3);
    expect((await h.app.request(statusPath, { key: h.keys.writer })).body).toEqual({
      id: first.body.id,
      status: 'succeeded',
      code: 'matched_shortcut',
    });

    const again = await press(ENRICHMENT.enrichCompanyNow);
    expect(again.status).toBe(202);
    expect(again.body.id).not.toBe(first.body.id);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'nothing_to_fill' }]);
    expect(h.exa.requests).toHaveLength(3);

    expect(
      (
        await h.app.request(`/v1/extensions/${h.id}/disable`, {
          key: h.keys.admin,
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect((await list('company')).body.buttons).toEqual([]);
    expect((await press(ENRICHMENT.enrichCompanyNow)).status).toBe(409);
  });

  it('cancels a queued button when its record was deleted', async () => {
    const h = await setup();
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    await h.drain();
    const run = await h.app.request(
      `/v1/extensions/${h.id}/record-buttons/${ENRICHMENT.enrichCompanyNow}`,
      {
        key: h.keys.writer,
        body: { recordId: acme },
      },
    );
    expect(run.status).toBe(202);
    expect(
      (
        await h.app.request(`/v1/records/${acme}`, {
          key: h.keys.admin,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(await h.queue.claim(h.workspace, run.body.id, 'enrichment-test')).toBeNull();
    const result = await h.app.request(`/v1/extensions/${h.id}/record-button-runs/${run.body.id}`, {
      key: h.keys.writer,
    });
    expect(result.body).toMatchObject({ status: 'cancelled', code: 'record_unavailable' });
    expect(h.exa.requests).toHaveLength(1);
  });

  it('upgrades a workspace-key installation without asking for a key or changing its mapping', async () => {
    const h = await setup({ legacy: true });
    await h.drain();
    const previous = await h.detail();
    expect(previous).toMatchObject({ state: 'active', secrets: { apiKey: true } });
    const buttons = () =>
      h.app.request('/v1/extensions/record-buttons?object=company', { key: h.keys.writer });
    expect((await buttons()).body.buttons).toEqual([]);
    await h.upgrade();
    await h.drain();
    expect((await buttons()).body.buttons).toEqual([
      { installationId: h.id, functionId: ENRICHMENT.enrichCompanyNow, label: 'Enrich now' },
    ]);
    expect(await h.detail()).toMatchObject({
      state: 'active',
      version: h.currentVersion,
      settings: previous.settings,
      bindingChoices: previous.bindingChoices,
    });
    expect(h.exa.requests[0]).toMatchObject({ key: 'exa-fixture-key' });
    const company = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(h.exa.requests.at(-1)).toMatchObject({ key: 'exa-fixture-key' });
    expect((await h.fields(company)).employeeCount).toBe(12);
  });

  it('upgrades a workspace-key installation that a failed setup left disabled', async () => {
    const h = await setup({ legacy: true });
    await h.drain();
    const previous = await h.detail();
    // A setup run at the installed release failed, as on the hosted service.
    await db.owner`update extension_installations set state='disabled', setup_kind='upgrade',
      last_error='handler_failed' where id=${h.id}`;
    // Suggestions need an active installation, and the refusal says so.
    const access = await h.app.request('/v1/extensions/preview', {
      key: h.keys.admin,
      body: { ...h.upgradeInput, accessOnly: true },
    });
    expect(access.status).toBe(409);
    expect(access.body.error.code).toBe('installation_disabled');
    // The full review upgrades it, keeps its mapping and turns it back on.
    await h.upgrade();
    const runs = await h.drain();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    expect(await h.detail()).toMatchObject({
      state: 'active',
      version: h.currentVersion,
      lastError: null,
      bindingChoices: previous.bindingChoices,
    });
    const company = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect((await h.fields(company)).employeeCount).toBe(12);
  });

  it('makes no request for a blank domain and enriches once one is added', async () => {
    const h = await setup();
    await h.drain();
    const blank = await h.company({ name: 'No site yet' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_domain' }]);
    expect(h.exa.requests.filter((r) => r.path === '/search')).toEqual([]);
    // A new name is looked up again, and still needs a domain.
    expect((await h.patch(blank, { name: 'Renamed' })).status).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_domain' }]);
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

  it('reports a deployment credential failure and exhausted credits without requesting reconnect', async () => {
    const rejected = await setup();
    rejected.exa.team = () => new Response('{}', { status: 401 });
    rejected.exa.search = () => new Response('{}', { status: 401 });
    expect(await rejected.drain()).toEqual([
      { status: 'failed', code: 'provider_credentials_rejected' },
    ]);
    expect(rejected.exa.requests.map((r) => r.path)).toEqual(['/websets/v0/teams/me', '/search']);
    expect(await rejected.detail()).toMatchObject({
      state: 'setup_failed',
      connectionHealth: 'degraded',
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

  it('refuses to delete an output while the approved binding needs it', async () => {
    const h = await setup();
    await h.drain();
    const changed = await h.app.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: { operations: [{ op: 'delete_field', object: 'company', field: 'headquarters' }] },
    });
    expect(changed.status).toBe(422);
    expect(changed.body.error.details.issues[0].message).toMatch(
      /change Exa enrichment's setup first/i,
    );
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
      model: 'claude-haiku-5-5',
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

  it('looks a company up again when it gets a name', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = () => twoResults('https://fixture.example/', 'fixture.example');
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const unnamed = await h.company({ domain: 'old-fixture.example' });
    // No name: a pick on another domain can't be accepted.
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_match_model' }]);
    expect((await h.fields(unnamed)).employeeCount).toBeUndefined();
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    expect((await h.patch(unnamed, { name: 'Fixture Co' })).status).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_high' }]);
    expect((await h.fields(unnamed)).employeeCount).toBe(12);
    // Once filled, another new name stops before a search.
    const searches = h.exa.requests.length;
    expect((await h.patch(unnamed, { name: 'Fixture Company' })).status).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'nothing_to_fill' }]);
    expect(h.exa.requests).toHaveLength(searches);
  });

  it('keeps watching a bound name after the workspace renames it', async () => {
    const h = await setup();
    await h.drain();
    const changed = await h.app.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [{ op: 'rename_field', object: 'company', field: 'name', name: 'tradingName' }],
      },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const acme = await h.company({ tradingName: 'Acme' });
    await h.drain();
    expect((await h.patch(acme, { domain: 'acme.example' })).status).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(h.exa.requests.at(-1)?.body?.query).toBe('Acme acme.example');
    expect((await h.fields(acme)).employeeCount).toBe(12);
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

  it('uses the approved name field when the label is an email', async () => {
    const h = await setup();
    await h.drain();
    const changed = await h.app.request('/v1/schema/changes', {
      key: h.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: { name: 'billingEmail', label: 'Billing email', type: 'emails' },
          },
          { op: 'update_object', object: 'company', labelField: 'billingEmail' },
        ],
      },
    });
    expect(changed.status).toBe(200);
    h.exa.search = (domain) => Response.json(exaCompany(`https://${domain}/`));
    await h.company({
      name: 'Acme',
      domain: 'acme.example',
      billingEmail: 'billing@acme.example',
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(h.exa.requests.at(-1)?.body?.query).toBe('Acme acme.example');
    expect(JSON.stringify(h.exa.requests)).not.toContain('billing@');
  });

  it('ends without a match when the server has no model key', async () => {
    const h = await setup({ modelKey: false });
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

  it('asks the model again when the run retries after the model call', async () => {
    const h = await setup();
    await h.drain();
    h.exa.search = (domain) => twoResults('https://redirect.example/', domain);
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const before = messages().length;
    h.failNext('/runtime/mapped-writes');
    const acme = await h.company({ name: 'Acme', domain: 'acme.example' });
    expect(await h.drain()).toEqual([{ status: 'retry', code: 'api_unavailable' }]);
    await db.owner`update extension_jobs set available_at=clock_timestamp() where installation_id=${h.id} and status='queued'`;
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_model_high' }]);
    // Nothing is kept between attempts (spec 6.5), so nothing is left in KV.
    expect(messages()).toHaveLength(before + 2);
    expect((await h.fields(acme)).employeeCount).toBe(12);
    expect(
      await db.owner`select 1 from extension_kv where installation_id=${h.id} and key like 'pick:%'`,
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
    return {
      results,
      mapping: Object.fromEntries(
        Object.entries<Record<string, unknown>>(saved.body.bindings.company.fields).map(
          ([key, choice]) => [
            key,
            { ...choice, reason: saved.body.bindingReasons[`company.${key}`] },
          ],
        ),
      ),
    };
  };

  it('suggests the mapping with the model, from sampled companies and the current mapping', async () => {
    const h = await setup();
    await h.drain();
    await h.company({ name: 'Sampled', domain: 'sampled.example', employeeCount: 340 });
    await h.drain();
    upstream.respond(
      structured({
        company: {
          action: 'existing',
          object: 'company',
          reason: 'It holds the companies.',
          fields: {
            domain: { action: 'existing', field: 'domain', reason: 'The website.' },
            employee_count: {
              action: 'existing',
              field: 'employeeCount',
              reason: 'It holds head counts.',
            },
            linkedin_url: { action: 'skip', field: '', reason: 'Not wanted.' },
            headquarters: { action: 'existing', field: 'headquarters', reason: 'Same meaning.' },
          },
        },
        person: { action: 'skip', object: '', reason: 'No contacts here.' },
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
    const companies = prompt.bindings.find((b: { key: string }) => b.key === 'company');
    const object = companies.candidates.find((o: { name: string }) => o.name === 'company');
    expect(
      object.fields.find((f: { name: string }) => f.name === 'employeeCount').samples,
    ).toContain(340);
    expect(prompt.currentBindings.company.fields.employee_count).toMatchObject({
      field: 'employeeCount',
    });
    const usage = await db.owner<{ function_id: string; model: string }[]>`
      select function_id,model from ai_usage where installation_id=${h.id}`;
    expect(usage).toEqual([{ function_id: ENRICHMENT.configure, model: 'claude-haiku-5-5' }]);
  });

  it('falls back to API-name suggestions when the server has no model key', async () => {
    const h = await setup({ modelKey: false });
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

describe('people enrichment (enrichment spec 7)', () => {
  const people = {
    action: 'existing',
    objects: ['person'],
    fields: {
      name: { action: 'existing', field: 'name' },
      email: { action: 'existing', field: 'emails' },
      company: { action: 'existing', field: 'company' },
      job_title: { action: 'existing', field: 'jobTitle' },
      seniority: { action: 'create' },
      linkedin_url: { action: 'create' },
      headline: { action: 'skip' },
      location: { action: 'skip' },
      department: { action: 'skip' },
    },
  };

  it('enriches an existing person from their record button without sharing email', async () => {
    const h = await setup({ person: people });
    await h.drain();
    const company = await h.company({ name: 'Fixture Co', domain: 'fixture.example' });
    const ada = await h.person({
      name: { first: 'Ada', last: 'Example' },
      emails: { primary: 'ada@fixture.example' },
      company,
      jobTitle: 'Chief Executive',
    });
    const search = h.exa.people;
    h.exa.people = () => Response.json({ results: [] });
    await h.drain();
    expect((await h.fields(ada)).seniority).toBeUndefined();
    h.exa.people = search;
    const list = await h.app.request('/v1/extensions/record-buttons?object=person', {
      key: h.keys.writer,
    });
    expect(list.body.buttons).toEqual([
      { installationId: h.id, functionId: ENRICHMENT.enrichPersonNow, label: 'Enrich now' },
    ]);
    const started = await h.app.request(
      `/v1/extensions/${h.id}/record-buttons/${ENRICHMENT.enrichPersonNow}`,
      {
        key: h.keys.writer,
        body: { recordId: ada },
      },
    );
    expect(started.status).toBe(202);
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(await h.fields(ada)).toMatchObject({
      jobTitle: 'Chief Executive',
      seniority: 'C-Level',
    });
    expect(h.exa.requests.at(-1)?.body).toMatchObject({
      category: 'people',
      query: 'Ada Example Fixture Co fixture.example',
    });
    expect(JSON.stringify(h.exa.requests)).not.toContain('ada@');
  });

  it('fills a new person from their linked company, keeping what a person set', async () => {
    const h = await setup({ person: people });
    await h.drain();
    const acme = await h.company({ name: 'Fixture Co', domain: 'fixture.example' });
    await h.drain();
    const ada = await h.person({
      name: { first: 'Ada', last: 'Example' },
      emails: { primary: 'ada@fixture.example' },
      company: acme,
      jobTitle: 'Chief Executive',
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    const filled = await h.fields(ada);
    expect(filled.jobTitle).toBe('Chief Executive');
    expect(filled.seniority).toBe('C-Level');
    expect(filled.linkedinUrl).toMatchObject({
      primary: { url: 'https://www.linkedin.com/in/ada-example-fixture' },
    });
    const search = h.exa.requests.at(-1);
    expect(search?.body).toMatchObject({
      category: 'people',
      query: 'Ada Example Fixture Co fixture.example',
    });
    // The email address never leaves Retainer; only its company's domain does.
    expect(JSON.stringify(h.exa.requests)).not.toContain('ada@');
  });

  it('writes nothing looked up for an email the person no longer has', async () => {
    const h = await setup({ person: people });
    await h.drain();
    const ada = await h.person({
      name: { first: 'Ada', last: 'Example' },
      emails: { primary: 'ada@fixture.example' },
    });
    let changed = false;
    h.exa.people = async () => {
      if (!changed) {
        changed = true;
        expect((await h.patch(ada, { emails: { primary: 'ada@elsewhere.example' } })).status).toBe(
          200,
        );
      }
      return Response.json(exaPerson('Elsewhere'));
    };
    // Only an email domain to go by, so the model picks.
    upstream.respond(structured({ index: 0, certainty: 'high' }));
    const [first] = await h.drain();
    expect(first).toEqual({ status: 'succeeded', code: 'lookup_changed' });
    expect((await h.fields(ada)).seniority).toBeUndefined();
  });

  it('doesn’t search a person with no company and a personal email', async () => {
    const h = await setup({ person: people });
    await h.drain();
    const before = h.exa.requests.length;
    await h.person({
      name: { first: 'Ada', last: 'Example' },
      emails: { primary: 'ada@gmail.com' },
    });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'no_company' }]);
    expect(h.exa.requests).toHaveLength(before);
  });

  it('fills a company’s new details from the same search', async () => {
    const h = await setup({
      company: {
        industry: { action: 'create' },
        total_funding: { action: 'create' },
        last_funding_round: { action: 'create' },
      },
    });
    await h.drain();
    h.exa.search = (domain) => {
      const body = exaCompany(`https://www.${domain}/`);
      const properties = body.results[0]?.entities[0]?.properties as Record<string, unknown>;
      properties.financials = {
        revenueAnnual: null,
        fundingTotal: 18_500_000,
        fundingLatestRound: { name: 'Series a', date: '2026-03-01', amount: 11_300_000 },
      };
      return Response.json(body);
    };
    const acme = await h.company({ name: 'Fixture Co', domain: 'fixture.example' });
    expect(await h.drain()).toEqual([{ status: 'succeeded', code: 'matched_shortcut' }]);
    expect(await h.fields(acme)).toMatchObject({
      industry: 'Software',
      totalFunding: { amountMicros: 18_500_000_000_000, currency: 'USD' },
      lastFundingRound: 'Series A',
    });
  });
});
