import { z } from 'zod';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const fileMetadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        ![...value].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\',
        ),
      'invalid filename',
    ),
  mediaType: z
    .string()
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)
    .max(150),
  bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FileMetadata = z.infer<typeof fileMetadataSchema>;
export const objectKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export type SignedTransfer = { url: string; headers: Record<string, string>; expiresAt: string };
export type StoredObject = { bytes: number; sha256: string; mediaType: string; version?: string };
export interface FileStorage {
  readonly id: string;
  upload(key: string, metadata: FileMetadata, audience?: 'public' | 'run'): Promise<SignedTransfer>;
  head(key: string): Promise<StoredObject | null>;
  download(
    key: string,
    metadata: FileMetadata,
    audience?: 'public' | 'run',
  ): Promise<SignedTransfer>;
  /** Remove all content/versions; a zero-byte tombstone prevents delayed signed uploads from recreating it. */
  erase(key: string, signal?: AbortSignal): Promise<void>;
}
export const disposition = (name: string) =>
  `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", '%27')}`;
