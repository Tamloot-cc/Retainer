import { MastraCompositeStore } from '@mastra/core/storage';
import { MemoryPG, WorkflowsPG } from '@mastra/pg';
import pg from 'pg';

/** Mastra's tables live in this schema, reached only by the `retainer_mastra` role (spec §5.2). */
export const MASTRA_SCHEMA = 'mastra';

export interface MastraStoreHandle {
  store: MastraCompositeStore;
  close(): Promise<void>;
}

/**
 * Mastra's store for the agent runtime and the API's chat read endpoints:
 * a composite store with only the `memory` and `workflows` domains, in the
 * `mastra` schema, that never runs DDL (`disableInit` on the composite store,
 * where Mastra reads it). One small pool shared by both domains.
 */
export function createMastraStore(opts: {
  connectionString: string;
  max?: number;
}): MastraStoreHandle {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 2,
    idleTimeoutMillis: 30_000,
  });
  // An idle client error must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  const store = new MastraCompositeStore({
    id: 'retainer-agent',
    disableInit: true,
    domains: {
      memory: new MemoryPG({ pool, schemaName: MASTRA_SCHEMA, skipDefaultIndexes: false }),
      workflows: new WorkflowsPG({ pool, schemaName: MASTRA_SCHEMA, skipDefaultIndexes: false }),
    },
  });
  return {
    store,
    close: () => pool.end(),
  };
}

/**
 * Creates or upgrades Mastra's tables for the two domains, as the role it is
 * given (the migration role). Idempotent. Grants are the caller's job.
 */
export async function initMastraSchema(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', () => {});
  try {
    await pool.query(`create schema if not exists ${MASTRA_SCHEMA}`);
    const memory = new MemoryPG({ pool, schemaName: MASTRA_SCHEMA });
    const workflows = new WorkflowsPG({ pool, schemaName: MASTRA_SCHEMA });
    await memory.init();
    await workflows.init();
  } finally {
    await pool.end();
  }
}
