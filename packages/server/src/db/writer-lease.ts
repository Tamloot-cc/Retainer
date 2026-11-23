import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../log.js';
import type { Sql } from './client.js';

export const WRITER_ADMISSION_LOCK = 0x52544e09;
/** Serializes ops metadata transitions without entering the writer fence. */
export const WRITER_CONTROL_LOCK = 0x52544e0a;

export class WriterAdmissionDenied extends Error {
  constructor() {
    super('retainer writer admission denied');
  }
}

/** A lease survives pool loss. An uncertain invocation retains its lease until its hard deadline. */
export async function acquireWriterLease(
  sql: Sql,
  remainingMs: number,
  options: { peerBuild?: string; effect?: string; id?: string; acquireBy?: Date } = {},
) {
  const id = options.id ?? randomUUID();
  const [row] = await sql<{ state: 'leased' | 'unmanaged' | 'denied' }[]>`
    select retainer_deploy.acquire_writer(
      ${id}, ${remainingMs}, ${options.peerBuild ?? null}, ${options.effect ?? null}, ${options.acquireBy ?? null}) as state`;
  if (row?.state === 'unmanaged') return undefined;
  if (row?.state !== 'leased') throw new WriterAdmissionDenied();
  return id;
}

export async function releaseWriterLease(sql: Sql, id: string | undefined, peerBuild?: string) {
  if (id) await sql`select retainer_deploy.release_writer(${id}, ${peerBuild ?? null})`;
}

/** Releases a known outcome even if the first query is lost during a reconnect. */
export async function settleWriterLease(sql: Sql | undefined, id: string | undefined) {
  if (!sql || !id) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await releaseWriterLease(sql, id);
      return;
    } catch {
      if (attempt < 2) await delay(50 * (attempt + 1));
    }
  }
  log.warn('Writer admission lease release failed', { lease: id });
}
