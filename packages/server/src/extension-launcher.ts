import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decodeInvocation } from '@retainer/extension';
import { z } from 'zod';
import { bundleSchema, DockerSandbox } from './launcher/docker.js';

const token = process.env.RETAINER_LAUNCHER_TOKEN;
if (!token || token.length < 32)
  throw new Error('RETAINER_LAUNCHER_TOKEN must contain at least 32 characters');
const expected = Buffer.from(`Bearer ${token}`);
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
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url !== '/run' || req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 131072) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const parsed = z
      .strictObject({ bundleId: z.string(), invocation: z.unknown() })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const invocation = decodeInvocation(JSON.stringify(parsed.invocation));
    const result = await sandbox.run(parsed.bundleId, invocation, controller.signal);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(result));
  } catch {
    if (!res.headersSent) res.writeHead(503);
    res.end('{"status":"retry","code":"launcher_unavailable"}');
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
