import { MastraCompositeStore } from '@mastra/core/storage';
import { MemoryPG } from '@mastra/pg';
import pg from 'pg';

/** Mastra's tables live in this schema, reached only by the `retainer_mastra` role (spec §5.2). */
export const MASTRA_SCHEMA = 'mastra';

export interface MastraStoreHandle {
  store: MastraCompositeStore;
  close(): Promise<void>;
}

/** Refused once a store's fence has passed (spec §5.2, "one writer per session"). */
export class StoreFencedError extends Error {
  constructor() {
    super('the Mastra store is past its fence');
    this.name = 'StoreFencedError';
  }
}

type FencedClient = pg.PoolClient & { connectionParameters: { query_timeout?: number } };

/**
 * A pool that hands out no connection after its fence, and gives each query
 * no longer than the time left before it, measured when the client is handed
 * out for that query (`pool.query` takes a client per query): a turn's saves
 * end by its deadline plus the grace, so steps from two turns never
 * interleave.
 */
export class FencedPool extends pg.Pool {
  readonly #fence: number;

  constructor(config: pg.PoolConfig, fence: number) {
    super(config);
    this.#fence = fence;
  }

  /** The time left before the fence, for the wait for a connection and for its queries. */
  #left(): number {
    return Math.max(1, this.#fence - Date.now());
  }

  #limit(client: FencedClient): FencedClient {
    // pg reads it on every `client.query` without its own timeout.
    client.connectionParameters.query_timeout = this.#left();
    return client;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloads (promise and callback forms).
  override connect(...args: any[]): any {
    const callback = args[0];
    if (Date.now() >= this.#fence) {
      const error = new StoreFencedError();
      if (typeof callback === 'function') {
        process.nextTick(() => callback(error));
        return undefined;
      }
      return Promise.reject(error);
    }
    this.options.connectionTimeoutMillis = this.#left();
    if (typeof callback === 'function') {
      // biome-ignore lint/suspicious/noExplicitAny: pg's callback form.
      return super.connect((error: Error | undefined, client: any, release: any) =>
        callback(error, client ? this.#limit(client) : client, release),
      );
    }
    return super.connect().then((client) => this.#limit(client as FencedClient));
  }
}

/**
 * Mastra's store for the agent runtime and the API's chat read endpoints:
 * a composite store with only the `memory` domain, in the `mastra` schema,
 * that never runs DDL (`disableInit` on the composite store, where Mastra
 * reads it). PR 1 found that Mastra's loop writes no `workflows` row without
 * approvals, so that domain is left out until approvals come (spec §5.1).
 */
export function createMastraStore(opts: {
  connectionString: string;
  max?: number;
  /** Epoch ms after which the store opens no connection and runs no query. */
  fence?: number;
}): MastraStoreHandle {
  const config: pg.PoolConfig = {
    connectionString: opts.connectionString,
    max: opts.max ?? 2,
    idleTimeoutMillis: 30_000,
  };
  let pool: pg.Pool;
  if (opts.fence !== undefined) {
    pool = new FencedPool(config, opts.fence);
  } else {
    pool = new pg.Pool(config);
  }
  // An idle client error must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  const store = new MastraCompositeStore({
    id: 'retainer-agent',
    disableInit: true,
    domains: {
      memory: new MemoryPG({ pool, schemaName: MASTRA_SCHEMA, skipDefaultIndexes: false }),
    },
  });
  return {
    store,
    close: () => pool.end(),
  };
}

/**
 * Creates or upgrades Mastra's tables for the `memory` domain, as the role it is
 * given (the migration role). Idempotent. Grants are the caller's job.
 */
export async function initMastraSchema(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', () => {});
  try {
    await pool.query(`create schema if not exists ${MASTRA_SCHEMA}`);
    const memory = new MemoryPG({ pool, schemaName: MASTRA_SCHEMA });
    await memory.init();
  } finally {
    await pool.end();
  }
}
