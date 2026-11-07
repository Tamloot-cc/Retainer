import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  API_STATEMENT_TIMEOUT_MS,
  createApiSql,
  createRuntimeSql,
  type createSql,
  RUNTIME_ROLE,
} from '../../src/db/client.js';
import { toAppError } from '../../src/http/response.js';
import { useTestDatabase } from '../helpers/db.js';

// The statement timeout (accounts spec 4.8): the API's pool cancels a
// statement before API Gateway's 29-second limit; the worker's pool does not,
// because a consolidator pass may run for minutes. Both run as the runtime
// role whether they log in as it or switch to it.

const db = useTestDatabase();

async function settings(sql: ReturnType<typeof createSql>) {
  const [row] = await sql<{ timeout: string; role: string }[]>`
    select current_setting('statement_timeout') as timeout, current_user as role`;
  return row;
}

describe('statement timeout', () => {
  it('is set on the API pool, below the 29-second request limit', async () => {
    expect(API_STATEMENT_TIMEOUT_MS).toBeLessThan(29_000);
    const api = createApiSql(loadConfig({ DATABASE_URL: db.url }), { max: 1 });
    try {
      expect(await settings(api)).toEqual({
        timeout: `${API_STATEMENT_TIMEOUT_MS / 1000}s`,
        role: RUNTIME_ROLE,
      });
    } finally {
      await api.end();
    }
  });

  it('is not set on the worker pool, which a long consolidator pass uses', async () => {
    const worker = createRuntimeSql(loadConfig({ DATABASE_URL: db.url }), { max: 1 });
    try {
      expect(await settings(worker)).toEqual({ timeout: '0', role: RUNTIME_ROLE });
    } finally {
      await worker.end();
    }
  });

  it('cancels a slow statement, which the API reports as a 503 asking to narrow it', async () => {
    const sql = db.connect({ max: 1, role: RUNTIME_ROLE, statementTimeoutMs: 50 });
    const error = await sql`select pg_sleep(2)`.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('57014');
    const reported = toAppError(error);
    expect(reported.status).toBe(503);
    expect(reported.code).toBe('timeout');
  });
});
