import type { Tx } from '../db/tx.js';

export type MonthUsage = {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** An installation's model use this calendar month (UTC), for its Overview tab. */
export async function installationMonthUsage(
  tx: Tx,
  installationId: string,
  now = new Date(),
): Promise<MonthUsage> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await tx<
    {
      requests: number;
      input: string;
      output: string;
      cache_read: string;
      cache_write: string;
    }[]
  >`select count(*)::int as requests,coalesce(sum(input_tokens),0)::text as input,
      coalesce(sum(output_tokens),0)::text as output,coalesce(sum(cache_read_tokens),0)::text as cache_read,
      coalesce(sum(cache_write_tokens),0)::text as cache_write
    from ai_usage where installation_id=${installationId} and created_at>=${start}`;
  return {
    month: start.toISOString().slice(0, 7),
    requests: row?.requests ?? 0,
    inputTokens: Number(row?.input ?? 0),
    outputTokens: Number(row?.output ?? 0),
    cacheReadTokens: Number(row?.cache_read ?? 0),
    cacheWriteTokens: Number(row?.cache_write ?? 0),
  };
}
