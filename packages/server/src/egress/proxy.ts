import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { connect, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { EgressPolicy } from './policy.js';

/** Private execution-network proxy. Pin DNS once per connection, rechecking every redirect's destination. */
export function createEgressProxy(policy: EgressPolicy) {
  const sockets = new Set<Duplex>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '');
      if (
        url.protocol !== 'http:' ||
        url.username ||
        url.password ||
        !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')
      )
        throw new Error('denied');
      const destination = await policy.destination(url.hostname, Number(url.port || 80));
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      for (const name of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade'])
        delete headers[name];
      const upstream = httpRequest(
        {
          hostname: destination.address,
          family: destination.family,
          port: destination.port,
          method: req.method,
          path: url.pathname + url.search,
          headers,
          timeout: 330000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.on('error', () => res.destroy());
          response.pipe(res);
        },
      );
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) upstream.destroy();
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end('egress denied');
    }
  });
  server.on('connect', async (req, client, head) => {
    let upstream: ReturnType<typeof connect> | undefined;
    try {
      if (sockets.size >= 128) throw new Error('capacity');
      const url = new URL(`http://${req.url}`);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('denied');
      const target = await policy.destination(url.hostname, Number(url.port || 80));
      upstream = connect({ host: target.address, family: target.family, port: target.port });
      const remote = upstream;
      sockets.add(client);
      sockets.add(remote);
      let bytes = head.length;
      const count = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024 * 1024) {
          client.destroy();
          remote.destroy();
        }
      };
      if (client instanceof Socket) client.setTimeout(330000, () => client.destroy());
      remote.setTimeout(330000, () => remote.destroy());
      client.on('data', count);
      remote.on('data', count);
      client.on('error', () => remote.destroy());
      remote.on('error', () => client.destroy());
      client.on('close', () => {
        sockets.delete(client);
        remote.destroy();
      });
      remote.on('close', () => {
        sockets.delete(remote);
        client.destroy();
      });
      remote.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
    } catch {
      upstream?.destroy();
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('close', () => {
    for (const socket of sockets) socket.destroy();
  });
  server.maxConnections = 128;
  server.requestTimeout = 330000;
  server.headersTimeout = 10000;
  return server;
}
