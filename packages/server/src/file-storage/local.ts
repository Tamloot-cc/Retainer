import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import {
  disposition,
  type FileMetadata,
  type FileStorage,
  fileMetadataSchema,
  objectKeySchema,
  type SignedTransfer,
  type StoredObject,
} from './contract.js';

const ticketSchema = z.strictObject({
  version: z.literal(1),
  action: z.enum(['upload', 'download', 'head', 'erase']),
  key: objectKeySchema,
  expires: z.number().int().positive(),
  metadata: fileMetadataSchema.optional(),
});
type Ticket = z.infer<typeof ticketSchema>;
export class FileTickets {
  constructor(private readonly key: Uint8Array) {
    if (key.length < 32) throw new Error('file signing key requires at least 32 bytes');
  }
  sign(input: Ticket) {
    const ticket = ticketSchema.parse(input),
      payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
  }
  verify(value: string, action: Ticket['action']): Ticket {
    if (value.length > 4096) throw new Error('invalid file ticket');
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) throw new Error('invalid file ticket');
    const expected = createHmac('sha256', this.key).update(payload).digest(),
      received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw new Error('invalid file ticket');
    const ticket = ticketSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    const remaining = ticket.expires - Date.now();
    if (
      ticket.action !== action ||
      remaining <= 0 ||
      remaining > (action === 'upload' ? 300000 : 60000)
    )
      throw new Error('expired file ticket');
    if (['upload', 'download'].includes(action) && !ticket.metadata)
      throw new Error('file metadata required');
    return ticket;
  }
}
export class LocalFileStorage implements FileStorage {
  private readonly origin: string;
  private readonly tickets: FileTickets;
  constructor(
    origin: string,
    key: Uint8Array,
    private readonly transport: typeof fetch = fetch,
    readonly id = 'local-v1',
    private readonly endpoints: { controlOrigin?: string; executionOrigin?: string } = {},
  ) {
    const url = new URL(origin);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('invalid file origin');
    for (const origin of Object.values(endpoints)) {
      const parsed = new URL(origin);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('invalid file endpoint');
    }
    this.origin = url.origin;
    this.tickets = new FileTickets(key);
  }
  private transfer(
    action: Ticket['action'],
    key: string,
    metadata?: FileMetadata,
    audience: 'public' | 'run' = 'public',
  ): SignedTransfer {
    const expires = Date.now() + (action === 'upload' ? 300000 : 60000);
    const token = this.tickets.sign({
      version: 1,
      action,
      key,
      expires,
      ...(metadata ? { metadata } : {}),
    });
    return {
      url: `${['head', 'erase'].includes(action) ? (this.endpoints.controlOrigin ?? this.origin) : audience === 'run' ? (this.endpoints.executionOrigin ?? this.origin) : this.origin}/objects/${key}?ticket=${token}`,
      headers: metadata ? { 'content-type': metadata.mediaType } : {},
      expiresAt: new Date(expires).toISOString(),
    };
  }
  async upload(key: string, metadata: FileMetadata, audience: 'public' | 'run' = 'public') {
    return this.transfer('upload', key, fileMetadataSchema.parse(metadata), audience);
  }
  async download(key: string, metadata: FileMetadata, audience: 'public' | 'run' = 'public') {
    return this.transfer('download', key, fileMetadataSchema.parse(metadata), audience);
  }
  async head(key: string): Promise<StoredObject | null> {
    const signed = this.transfer('head', key);
    const response = await this.transport(signed.url, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('file storage unavailable');
    const bytes = Number(response.headers.get('content-length')),
      sha256 = response.headers.get('x-content-sha256'),
      mediaType = response.headers.get('content-type');
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !sha256 ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !mediaType
    )
      throw new Error('invalid object metadata');
    return { bytes, sha256, mediaType };
  }
  async erase(key: string, signal?: AbortSignal) {
    const signed = this.transfer('erase', key);
    const response = await this.transport(signed.url, {
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error('file erasure unavailable');
  }
}

/** Dedicated byte service: no database credentials or CRM tokens. Its volume is never mounted in a runner. */
export function createFileServer(options: {
  directory: string;
  key: Uint8Array;
  allowedOrigins?: readonly string[];
}) {
  const tickets = new FileTickets(options.key),
    origins = options.allowedOrigins ?? [];
  const ready = mkdir(options.directory, { recursive: true, mode: 0o700 });
  void ready.catch(() => {});
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'PUT, GET, HEAD');
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(origin && origins.includes(origin) ? 204 : 403);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      let probe: string | undefined;
      try {
        await ready;
        probe = join(options.directory, `.health.${randomUUID()}`);
        const handle = await open(probe, 'wx', 0o600);
        await handle.close();
        res.end('{"status":"ok"}');
      } catch {
        res.writeHead(503);
        res.end('{"status":"unavailable"}');
      } finally {
        if (probe) await unlink(probe).catch(() => {});
      }
      return;
    }
    let temporary: string | undefined;
    try {
      await ready;
      const url = new URL(req.url ?? '', 'http://files'),
        key = objectKeySchema.parse(url.pathname.slice('/objects/'.length));
      if (!url.pathname.startsWith('/objects/')) throw new Error('invalid object');
      const action =
        req.method === 'PUT'
          ? 'upload'
          : req.method === 'GET'
            ? 'download'
            : req.method === 'HEAD'
              ? 'head'
              : req.method === 'DELETE'
                ? 'erase'
                : null;
      if (!action) throw new Error('invalid method');
      const ticket = tickets.verify(url.searchParams.get('ticket') ?? '', action);
      if (ticket.key !== key) throw new Error('wrong object');
      const path = join(options.directory, key);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (action === 'erase') {
        // Atomic replacement unlinks any open old inode. Retained zero-byte marker blocks late uploads.
        temporary = join(options.directory, `${key}.${randomUUID()}.pending`);
        const marker = await open(temporary, 'wx', 0o600);
        await marker.close();
        await rename(temporary, path);
        temporary = undefined;
        for (const name of await readdir(options.directory))
          if (name.startsWith(`${key}.`) && name.endsWith('.pending'))
            await unlink(join(options.directory, name)).catch(() => {});
        await unlink(`${path}.metadata`).catch(() => {});
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === 'upload') {
        const metadata = ticket.metadata;
        if (!metadata || req.headers['content-type'] !== metadata.mediaType)
          throw new Error('wrong media type');
        const declared = req.headers['content-length'];
        if (declared && Number(declared) !== metadata.bytes) throw new Error('wrong length');
        temporary = join(options.directory, `${key}.${randomUUID()}.pending`);
        const handle = await open(temporary, 'wx', 0o600);
        let bytes = 0;
        const digest = createHash('sha256');
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > metadata.bytes) throw new Error('oversized object');
            digest.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new Error('object write failed');
              offset += bytesWritten;
            }
          }
          if (bytes !== metadata.bytes || digest.digest('hex') !== metadata.sha256)
            throw new Error('wrong checksum');
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Hard-link is exclusive; neither another upload nor erasure can be overwritten.
        await link(temporary, path);
        const sidecar = await open(`${path}.metadata`, 'wx', 0o600);
        try {
          await sidecar.writeFile(JSON.stringify({ mediaType: metadata.mediaType }));
        } finally {
          await sidecar.close();
        }
        res.writeHead(201);
        res.end();
        return;
      }
      const file = await open(path, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size === 0) {
          res.writeHead(404);
          res.end();
          return;
        }
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0 }))
          hash.update(chunk);
        const metadataFile = await open(`${path}.metadata`, 'r');
        let mediaType: string;
        try {
          mediaType = z
            .strictObject({ mediaType: z.string() })
            .parse(JSON.parse(await metadataFile.readFile('utf8'))).mediaType;
        } finally {
          await metadataFile.close();
        }
        res.setHeader('content-length', info.size);
        res.setHeader('content-type', mediaType);
        res.setHeader('x-content-sha256', hash.digest('hex'));
        if (action === 'head') {
          res.writeHead(200);
          res.end();
          return;
        }
        res.setHeader('content-disposition', disposition(ticket.metadata?.name ?? 'download'));
        await new Promise<void>((resolve, reject) => {
          const stream = file.createReadStream({ autoClose: false, start: 0 });
          stream.on('error', reject);
          res.on('finish', resolve);
          res.on('close', () => {
            stream.destroy();
            resolve();
          });
          stream.pipe(res);
        });
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!res.headersSent)
        res.writeHead(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 404
            : (error as NodeJS.ErrnoException).code === 'EEXIST'
              ? 409
              : 400,
        );
      res.end();
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 128;
  return server;
}
