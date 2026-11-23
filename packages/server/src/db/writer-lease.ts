import { randomUUID } from 'node:crypto';
import type { Sql } from './client.js';

export const WRITER_ADMISSION_LOCK = 0x52544e09;
/** Serializes ops metadata transitions without entering the writer fence. */
export const WRITER_CONTROL_LOCK = 0x52544e0a;

const DENIED_MESSAGE = 'retainer writer admission denied';

export class WriterAdmissionDenied extends Error {
  constructor() {
    super(DENIED_MESSAGE);
  }
}

export function isWriterAdmissionDenied(error: unknown): boolean {
  const database = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const cause = database?.cause as { code?: unknown; message?: unknown } | null;
  return (
    error instanceof WriterAdmissionDenied ||
    (database?.code === '55000' && database.message === DENIED_MESSAGE) ||
    (cause?.code === '55000' && cause.message === DENIED_MESSAGE)
  );
}

/** A lease survives pool loss. An uncertain invocation retains its lease until its hard deadline. */
export async function acquireWriterLease(
  sql: Sql,
  remainingMs: number,
  options: { peerBuild?: string; effect?: string } = {},
) {
  const id = randomUUID();
  const [row] = await sql<{ state: 'leased' | 'unmanaged' | 'denied' }[]>`
    select retainer_deploy.acquire_writer(${id}, ${remainingMs}, ${options.peerBuild ?? null}, ${options.effect ?? null}) as state`;
  if (row?.state === 'unmanaged') return undefined;
  if (row?.state !== 'leased') throw new WriterAdmissionDenied();
  return id;
}

export async function releaseWriterLease(sql: Sql, id: string | undefined, peerBuild?: string) {
  if (id) await sql`select retainer_deploy.release_writer(${id}, ${peerBuild ?? null})`;
}
