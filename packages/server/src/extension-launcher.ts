import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decodeInvocation, decodeVerification } from '@retainer/extension';
import { z } from 'zod';
import { bundleSchema, DockerSandbox } from './launcher/docker.js';

const token = process.env.RETAINER_LAUNCHER_TOKEN;
if (!token || token.length < 32)
  throw new Error('RETAINER_LAUNCHER_TOKEN must contain at least 32 characters');
const expected = Buffer.from(`Bearer ${token}`);
const verifierToken = process.env.RETAINER_VERIFIER_TOKEN;
if (verifierToken && (verifierToken.length < 32 || verifierToken === token))
  throw new Error('verifier needs a distinct token of at least 32 characters');
const verifierExpected = verifierToken ? Buffer.from(`Bearer ${verifierToken}`) : undefined;
const sandbox = new DockerSandbox({
  socketPath: process.env.RETAINER_DOCKER_SOCKET ?? '/var/run/docker.sock',
  networkPrefix: process.env.RETAINER_EXECUTION_NETWORK_PREFIX ?? 'retainer-run',
  apiContainer: process.env.RETAINER_EXECUTION_API_CONTAINER ?? '',
  proxyContainer: process.env.RETAINER_EXECUTION_PROXY_CONTAINER ?? '',
  proxyOrigin: process.env.RETAINER_EXECUTION_PROXY ?? '',
  apiOrigin: process.env.RETAINER_EXECUTION_API_ORIGIN ?? '',
  bundles: z.array(bundleSchema).parse(JSON.parse(process.env.RETAINER_EXTENSION_BUNDLES ?? '[]')),
});
const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    try {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await sandbox.health()));
    } catch {
      res.writeHead(503);
      res.end('{"status":"unavailable"}');
    }
    return;
  }
  const verifying = req.url === '/verify';
  const authorization = verifying ? verifierExpected : expected;
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (
    !authorization ||
    supplied.length !== authorization.length ||
    !timingSafeEqual(supplied, authorization)
  ) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (!['/run', '/verify'].includes(req.url ?? '') || req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const budget = verifying
    ? setTimeout(() => {
        controller.abort();
        if (!res.headersSent) res.writeHead(503);
        res.end('{"status":"unavailable"}');
        req.destroy();
      }, 5000)
    : undefined;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > (verifying ? 1048576 : 131072)) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const parsed = z
      .strictObject({ bundleId: z.string(), invocation: z.unknown() })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const result = verifying
      ? await sandbox.verify(
          parsed.bundleId,
          decodeVerification(JSON.stringify(parsed.invocation)),
          controller.signal,
        )
      : await sandbox.run(
          parsed.bundleId,
          decodeInvocation(JSON.stringify(parsed.invocation)),
          controller.signal,
        );
    if (res.writableEnded || res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(result));
  } catch {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) res.writeHead(503);
    res.end('{"status":"retry","code":"launcher_unavailable"}');
  } finally {
    if (budget) clearTimeout(budget);
  }
});
server.requestTimeout = 310000;
server.headersTimeout = 10000;
const janitor = setInterval(() => {
  void sandbox.collectExpired().catch(() => {});
}, 60000);
janitor.unref();
server.listen(Number(process.env.PORT ?? 9000), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    clearInterval(janitor);
    void sandbox.stop().finally(() => server.close());
  });
