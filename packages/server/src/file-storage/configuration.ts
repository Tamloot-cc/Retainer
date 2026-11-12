import type { Config } from '../config.js';
import type { FileStorage } from './contract.js';
import { LocalFileStorage } from './local.js';
export async function createFileStorage(config: Config): Promise<FileStorage | undefined> {
  if (!config.RETAINER_FILE_STORAGE) return;
  try {
    if (config.RETAINER_FILE_STORAGE === 'local') {
      if (!config.RETAINER_FILE_PUBLIC_ORIGIN || !config.RETAINER_FILE_SIGNING_KEY)
        throw new Error('local file config missing');
      return new LocalFileStorage(
        config.RETAINER_FILE_PUBLIC_ORIGIN,
        Buffer.from(config.RETAINER_FILE_SIGNING_KEY, 'base64'),
        fetch,
        config.RETAINER_FILE_STORAGE_ID,
        {
          ...(config.RETAINER_FILE_CONTROL_ORIGIN
            ? { controlOrigin: config.RETAINER_FILE_CONTROL_ORIGIN }
            : {}),
          ...(config.RETAINER_FILE_EXECUTION_ORIGIN
            ? { executionOrigin: config.RETAINER_FILE_EXECUTION_ORIGIN }
            : {}),
        },
      );
    }
    if (!config.RETAINER_FILE_S3_BUCKET) throw new Error('bucket missing');
    const [{ S3Client }, { S3FileStorage }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('./s3.js'),
    ]);
    return new S3FileStorage(
      new S3Client({ requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } }),
      config.RETAINER_FILE_S3_BUCKET,
    );
  } catch {
    throw new Error(
      'invalid file storage configuration; check backend, origins, bucket and signing key',
    );
  }
}
