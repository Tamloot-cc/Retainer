import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExtensionManifest } from '@retainer/extension';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, expect } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { type ModelClaims, RunTokens } from '../../src/extension-runtime/tokens.js';
import type { ExtensionCatalog } from '../../src/extensions/catalog.js';
import type { TestApp } from './app.js';
import type { TestDatabase } from './db.js';
import { extensionFixture } from './extensions.js';

/** A request the fake Anthropic API received. */
export type Received = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
};
export type Upstream = {
  origin: string;
  received: Received[];
  /** Replaces how the next requests are answered. */
  respond: (handler: (request: Received, res: ServerResponse) => void | Promise<void>) => void;
  /** Resolves when the response to a request was closed before it finished. */
  aborted: () => Promise<void>;
};

const sse = (res: ServerResponse, type: string, data: object) =>
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

/** Answers like Messages: JSON, or a stream when the body asks for one. */
export function answer(request: Received, res: ServerResponse, model = 'claude-opus-5-5') {
  const body = request.body ? (JSON.parse(request.body) as { stream?: boolean }) : {};
  const usage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 };
  res.setHeader('request-id', `req_${randomUUID()}`);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 1 },
      },
    });
    sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } });
    sse(res, 'content_block_stop', { index: 0 });
    sse(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    sse(res, 'message_stop', {});
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage,
    }),
  );
}

/** A fake Anthropic API at the HTTP boundary, closed after the file's tests. */
export async function fakeAnthropic(): Promise<Upstream> {
  const received: Received[] = [];
  let handler: (request: Received, res: ServerResponse) => void | Promise<void> = answer;
  let onAbort: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    received.push(request);
    res.on('close', () => {
      if (!res.writableFinished) onAbort?.();
    });
    await handler(request, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    received,
    respond: (next) => {
      handler = next;
    },
    aborted: () =>
      new Promise<void>((resolve) => {
        onAbort = resolve;
      }),
  };
}

export async function testRunTokens() {
  const keys = await generateKeyPair('EdDSA');
  const tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  /** A model token with chosen times, for expiry tests. */
  const sign = (claims: ModelClaims, iat: number, exp: number, key = keys.privateKey) =>
    new SignJWT({ model: claims })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'retainer-model+jwt', kid: 'test' })
      .setIssuer('https://retainer.test')
      .setAudience('retainer:extension-model')
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key)
      .then((token) => `rt_model_${token}`);
  return { tokens, keys, sign };
}

export const modelFunction = (universalId: string, name: string, extra: object = {}) => ({
  universalId,
  name,
  description: 'Model fixture',
  handlerDigest: 'b'.repeat(64),
  trigger: { kind: 'job' as const },
  timeoutSeconds: 120,
  inputSchema: { type: 'object' as const, additionalProperties: false as const },
  ...extra,
});

export const PICK = '5e0c5a6f-1b2d-4c3e-8f4a-5b6c7d8e9f01';
export const PLAIN = '6f1d6b70-2c3e-4d4f-9a5b-6c7d8e9fa012';

/** A release whose `pick` function uses the model and whose `plain` one doesn't. */
export const modelRelease = (overrides: Partial<ExtensionManifest> = {}) =>
  extensionFixture({
    universalId: '8a3f8d92-4e5a-4f6b-8c7d-8e9fa0b1c234',
    requestedActor: 'agent',
    scopes: ['read', 'write'],
    functions: [modelFunction(PICK, 'pick', { uses: ['model'] }), modelFunction(PLAIN, 'plain')],
    ...overrides,
  });

/** Installs `release` in a new workspace with one approval and makes it active. */
export async function installModelRelease(
  t: TestApp,
  db: TestDatabase,
  release: ExtensionManifest,
) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Model ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const body = { registrationId: release.universalId, version: release.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body });
  expect(preview.status).toBe(200);
  const installed = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...body, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': `install-${randomUUID()}` },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  await db.owner`update extension_installations set state='active' where id=${id}`;
  await db.owner`update extension_jobs set status='succeeded',lease_until=null where installation_id=${id}`;
  return { workspace: workspace.id, key: keys.admin, id, preview: preview.body };
}

/** Claims a run of `functionId`, as the coordinator would. */
export async function claimRun(
  t: TestApp,
  catalog: ExtensionCatalog,
  workspace: string,
  installation: string,
  functionId: string,
) {
  const queue = new ExtensionQueue(t.sql, catalog.runtime);
  const { id } = await queue.enqueue(workspace, installation, {
    functionId,
    input: {},
    dedupeKey: `run-${randomUUID()}`,
  });
  const job = await queue.claim(workspace, id, `worker-${randomUUID()}`);
  if (!job) throw new Error('missing lease');
  return job;
}
