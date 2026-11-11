import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3FileStorage } from './s3.js';

const storage = new S3FileStorage(
  new S3Client({
    region: 'us-east-1',
    endpoint: 'https://s3.example.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
  }),
  'private-fixture',
);
const metadata = {
  name: 'transcript.html',
  mediaType: 'text/html',
  bytes: 3,
  sha256: createHash('sha256').update('abc').digest('hex'),
};
describe('private S3 signed transfer policy without live bucket access', () => {
  it('signs immutable checksum/size uploads for five minutes and attachment-only downloads for sixty seconds', async () => {
    const upload = await storage.upload('a'.repeat(64), metadata),
      url = new URL(upload.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining([
        'content-length',
        'content-type',
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-server-side-encryption',
      ]),
    );
    expect(upload.headers).toMatchObject({
      'if-none-match': '*',
      'content-length': '3',
      'x-amz-checksum-sha256': Buffer.from(metadata.sha256, 'hex').toString('base64'),
    });
    const download = new URL((await storage.download('a'.repeat(64), metadata)).url);
    expect(download.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(download.searchParams.get('response-content-disposition')).toMatch(/^attachment;/);
    expect(download.searchParams.get('response-content-type')).toBe('application/octet-stream');
  });
});
