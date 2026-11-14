import { isProfileAlias } from '@retainer/shared';
import type { Context } from 'hono';
import { z } from 'zod';
import { AppError, profileNotSupported } from '../errors.js';

/** Reads a body of at most `maxBytes`, or undefined (and the rest cancelled) when it is larger. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON body with a schema; malformed JSON and invalid shapes are 400s. */
export async function readBody<T extends z.ZodType>(
  c: Context,
  schema: T,
  maxBytes?: number,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    let text: string;
    if (maxBytes && c.req.raw.body) {
      const bytes = await readCapped(c.req.raw.body, maxBytes);
      if (!bytes)
        throw new AppError(
          413,
          'quota_exceeded',
          'request body exceeds the source transport limit',
        );
      text = Buffer.from(bytes).toString('utf8');
    } else text = await c.req.text();
    body = text.trim() === '' ? {} : JSON.parse(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_json', 'the request body is not valid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data;
}

export function zodError(error: z.ZodError): AppError {
  return new AppError(400, 'invalid_request', 'the request does not match the expected shape', {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

const uuid = z.uuid();

/** A path ID; anything that is not a UUID cannot exist, so it is a 404. */
export function idParam(c: Context, name = 'id'): string {
  const value = c.req.param(name) ?? '';
  // Workspace and personal memory work only on the routes that take them.
  if (isProfileAlias(value)) throw profileNotSupported(value);
  if (!uuid.safeParse(value).success) {
    throw new AppError(404, 'not_found', `${value} is not a valid ID`);
  }
  return value;
}

/**
 * A record ID, or `workspace` or `me` (personal memory spec 4.4): for the
 * routes that read or write facts, context and timelines.
 */
export function recordParam(c: Context, name = 'id'): string {
  const value = c.req.param(name) ?? '';
  return isProfileAlias(value) ? value : idParam(c, name);
}

export function limitParam(c: Context, fallback: number, max: number): number {
  const raw = c.req.query('limit');
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError(400, 'invalid_request', `limit must be an integer from 1 to ${max}`);
  }
  return value;
}
