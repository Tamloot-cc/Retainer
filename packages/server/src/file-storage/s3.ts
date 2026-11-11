import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  disposition,
  type FileMetadata,
  type FileStorage,
  fileMetadataSchema,
  objectKeySchema,
} from './contract.js';

/** Private, immutable S3 objects. Execution roles receive signed transfers, never bucket credentials. */
export class S3FileStorage implements FileStorage {
  get id() {
    return `aws-s3:${this.bucket}`;
  }
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!bucket) throw new Error('file bucket required');
  }
  async upload(key: string, raw: FileMetadata) {
    objectKeySchema.parse(key);
    const metadata = fileMetadataSchema.parse(raw);
    const checksum = Buffer.from(metadata.sha256, 'hex').toString('base64');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: metadata.bytes,
      ContentType: metadata.mediaType,
      ChecksumSHA256: checksum,
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: 300,
      signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-server-side-encryption']),
    });
    return {
      url,
      headers: {
        'content-type': metadata.mediaType,
        'content-length': String(metadata.bytes),
        'x-amz-checksum-sha256': checksum,
        'if-none-match': '*',
        'x-amz-server-side-encryption': 'AES256',
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }
  async head(key: string) {
    objectKeySchema.parse(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      if (result.ContentLength === 0) return null;
      if (result.ContentLength === undefined || !result.ChecksumSHA256 || !result.ContentType)
        throw new Error('object verification metadata missing');
      return {
        bytes: result.ContentLength,
        sha256: Buffer.from(result.ChecksumSHA256, 'base64').toString('hex'),
        mediaType: result.ContentType,
        ...(result.VersionId ? { version: result.VersionId } : {}),
      };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw new Error('file object verification unavailable');
    }
  }
  async download(key: string, metadata: FileMetadata) {
    objectKeySchema.parse(key);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition(metadata.name),
        ResponseContentType: 'application/octet-stream',
        ResponseCacheControl: 'no-store',
      }),
      { expiresIn: 60 },
    );
    return { url, headers: {}, expiresAt: new Date(Date.now() + 60000).toISOString() };
  }
  async erase(key: string, signal?: AbortSignal) {
    objectKeySchema.parse(key);
    const transport = signal ? { abortSignal: signal } : {};
    // Retain empty barriers from every claimant; reclaimed workers cannot remove each other's protection.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: new Uint8Array(),
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'AES256',
      }),
      transport,
    );
    const deadline = Date.now() + 240000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('file erasure deadline exceeded');
      const versions: { Key: string; VersionId: string }[] = [];
      let keyMarker: string | undefined, versionMarker: string | undefined;
      do {
        if (Date.now() > deadline) throw new Error('file erasure deadline exceeded');
        const page = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
          }),
          transport,
        );
        for (const version of page.Versions ?? []) {
          if (version.Key !== key) continue;
          if (!version.VersionId || version.Size === undefined)
            throw new Error('retained file version cannot be verified');
          if (version.Size > 0) versions.push({ Key: key, VersionId: version.VersionId });
        }
        for (const marker of page.DeleteMarkers ?? []) {
          if (marker.Key !== key) continue;
          if (!marker.VersionId) throw new Error('file deletion marker cannot be verified');
          versions.push({ Key: key, VersionId: marker.VersionId });
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker && versions.length < 1000);
      if (!versions.length) return;
      const deleted = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Quiet: true, Objects: versions.slice(0, 1000) },
        }),
        transport,
      );
      if (deleted.Errors?.length) throw new Error('retained file versions could not be erased');
      // Restart enumeration after removal; a deleted pagination marker must never skip older content.
    }
  }
}
