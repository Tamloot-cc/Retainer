import { exportJWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createModelApp } from '../../src/lambda/model.js';
import { MAX_REQUEST_BYTES } from '../../src/model/proxy.js';
import { reportUsage, USAGE_REPORT_PATH } from '../../src/model/routes.js';
import type { UsageReport } from '../../src/model/usage.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  claimRun,
  fakeAnthropic,
  installModelRelease,
  modelRelease,
  PICK,
  testRunTokens,
  type Upstream,
} from '../helpers/model.js';

// Model calls spec 3.6 and 7 (hosted `model` function): admission without the
// database, usage reported to the `extensions` function, the key required.
const db = useTestDatabase();
const SECRET = 'hosted-usage-secret-'.padEnd(40, 'x');
const release = modelRelease();
const catalog = new ExtensionCatalog([
  { manifest: release, actorCeiling: 'agent', runtimeEnabled: true },
]);
let t: TestApp,
  upstream: Upstream,
  env: Record<string, string>,
  token: string,
  installationId: string;

beforeAll(async () => {
  upstream = await fakeAnthropic();
  const { tokens, keys } = await testRunTokens();
  // The `extensions` function: it holds the database and the usage route.
  t = startTestApp(db, {
    extensionCatalog: catalog,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    modelUsageSecret: SECRET,
  });
  const installed = await installModelRelease(t, db, release);
  installationId = installed.id;
  token = await tokens.issueModel(
    await claimRun(t, catalog, installed.workspace, installed.id, PICK),
  );
  // No DATABASE_URL: the function admits model tokens by signature alone.
  env = {
    RETAINER_MODEL_API_KEY: 'sk-hosted-key',
    RETAINER_MODEL_USAGE_SECRET: SECRET,
    RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(await exportJWK(keys.publicKey)),
    RETAINER_EXTENSION_RUN_KEY_ID: 'test',
    RETAINER_EXTENSION_ISSUER: 'https://retainer.test',
    RETAINER_PUBLIC_ORIGIN: 'http://retainer.test',
    RETAINER_MODEL_UPSTREAM_ORIGIN: upstream.origin,
  };
});

const post = (
  app: { request: (url: string, init: RequestInit) => Promise<Response> | Response },
  body: string,
  key = token,
): Promise<Response> =>
  Promise.resolve(
    app.request('https://model.lambda-url.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body,
    }),
  );
const message = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] });

describe('the hosted model function', () => {
  it('fails to start without the key', async () => {
    const { RETAINER_MODEL_API_KEY: _, ...rest } = env;
    await expect(createModelApp(rest)).rejects.toThrow('RETAINER_MODEL_API_KEY');
    await expect(createModelApp({ ...env, RETAINER_MODEL_API_KEY: '' })).rejects.toThrow();
  });

  it('admits a model token with no database configured, and reports usage to the extensions function', async () => {
    const app = await createModelApp(
      { ...env, DATABASE_URL: '' },
      {
        record: reportUsage({
          origin: env.RETAINER_PUBLIC_ORIGIN as string,
          secret: SECRET,
          fetch: t.inProcessFetch as typeof fetch,
        }),
      },
    );
    const response = await post(app, message);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.received.at(-1)?.headers['x-api-key']).toBe('sk-hosted-key');
    const rows = await db.owner`select * from ai_usage where installation_id=${installationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ function_id: PICK, model: 'claude-opus-5-5', partial: false });
    expect((await post(app, message, 'rt_model_forged')).status).toBe(401);
  });

  it('refuses a body over 6 MB with 413', async () => {
    const app = await createModelApp(env, { record: async () => {} });
    const response = await post(app, 'x'.repeat(MAX_REQUEST_BYTES + 1));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
      'request_too_large',
    );
  });
});

describe('usage reports', () => {
  const report: UsageReport = {
    id: '0e9a2b3c-4d5e-4f60-8a71-b2c3d4e5f607',
    model: 'claude-opus-5-5',
    providerRequestId: 'req_1',
    partial: false,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usage: { input_tokens: 1, output_tokens: 2 },
    at: new Date().toISOString(),
  };

  it('retries a failed report, with the secret and the token, to the public origin', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers = [new Error('network'), new Response(null, { status: 503 }), new Response('{}')];
    const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next as Response;
    });
    const record = reportUsage({
      origin: 'https://retainer.example',
      secret: SECRET,
      fetch: fetcher as unknown as typeof fetch,
      backoffMs: 1,
    });
    await record('rt_model_token', {} as never, report);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`https://retainer.example${USAGE_REPORT_PATH}`);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ...report, token: 'rt_model_token' });
  });

  it('gives up after three tries and logs the ID and counts, no content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response(null, { status: 502 }));
    await reportUsage({
      origin: 'https://retainer.example',
      secret: SECRET,
      fetch: fetcher as unknown as typeof fetch,
      backoffMs: 1,
    })('rt_model_token', {} as never, report);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain(report.id);
    expect(logged).not.toContain('rt_model_token');
    expect(logged).not.toContain(SECRET);
    error.mockRestore();
  });

  it('does not retry a refused report', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    await reportUsage({
      origin: 'https://retainer.example',
      secret: SECRET,
      fetch: fetcher as unknown as typeof fetch,
      backoffMs: 1,
    })('rt_model_token', {} as never, report);
    expect(fetcher).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
