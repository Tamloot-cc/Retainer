import { randomUUID } from 'node:crypto';
import type { Sql } from './client.js';

export const WRITER_ADMISSION_LOCK = 0x52544e09;

export class WriterAdmissionDenied extends Error {
  constructor() {
    super('retainer writer admission denied');
  }
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
