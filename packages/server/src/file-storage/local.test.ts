import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileServer, FileTickets, LocalFileStorage } from './local.js';

const key = randomBytes(32),
  objectKey = 'a'.repeat(64),
  bytes = Buffer.from('private transcript fixture');
const metadata = {
  name: 'transcript.txt',
  mediaType: 'text/plain',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
let directory: string,
  origin: string,
  storage: LocalFileStorage,
  server: ReturnType<typeof createFileServer>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-file-test-'));
  server = createFileServer({ directory, key });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}`;
  storage = new LocalFileStorage(origin, key);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
describe('dedicated byte service with real local storage', () => {
  it('validates exact immutable upload, serves bounded attachment downloads, and leaves no overwrite capability', async () => {
    const upload = await storage.upload(objectKey, metadata);
    expect(
      (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes })).status,
    ).toBe(201);
    expect(await storage.head(objectKey)).toEqual({
      bytes: bytes.length,
      sha256: metadata.sha256,
      mediaType: metadata.mediaType,
    });
    expect(
      (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes })).status,
    ).toBe(409);
    const download = await storage.download(objectKey, metadata),
      response = await fetch(download.url);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(bytes.toString());
    expect(new Date(download.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60000);
  });
  it('revokes old object bytes and blocks late signed uploads with a zero-byte tombstone', async () => {
    const late = await storage.upload(objectKey, metadata);
    await storage.erase(objectKey);
    expect(await storage.head(objectKey)).toBeNull();
    expect(await readFile(join(directory, objectKey))).toHaveLength(0);
    expect(
      (await fetch(late.url, { method: 'PUT', headers: late.headers, body: bytes })).status,
    ).toBe(409);
  });
  it('rejects altered destinations, unsigned requests, unexpected bytes and expired tickets', async () => {
    const other = 'b'.repeat(64),
      upload = await storage.upload(other, metadata);
    expect((await fetch(`${origin}/objects/${other}`)).status).toBe(400);
    expect(
      (
        await fetch(upload.url.replace(other, 'c'.repeat(64)), {
          method: 'PUT',
          headers: upload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(upload.url, {
          method: 'PUT',
          headers: upload.headers,
          body: Buffer.from('wrong'),
        })
      ).status,
    ).toBe(400);
    expect(await storage.head(other)).toBeNull();
    const tickets = new FileTickets(key);
    expect(() =>
      tickets.verify(
        tickets.sign({
          version: 1,
          action: 'download',
          key: other,
          expires: Date.now() - 1,
          metadata,
        }),
        'download',
      ),
    ).toThrow('expired');
    await expect(storage.upload('../bad', metadata)).rejects.toThrow();
  });
});
