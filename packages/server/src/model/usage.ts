import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue } from '../db/tx.js';
import type { ModelClaims } from '../extension-runtime/tokens.js';

/**
 * Usage of one model request, read from Anthropic's response (model calls spec
 * 3.4). Counts and short labels only, never content.
 */
export const usageReportSchema = z.strictObject({
  id: z.uuid(),
  model: z.string().min(1).max(200),
  providerRequestId: z.string().max(200).nullable(),
  partial: z.boolean(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  usage: z.record(z.string(), z.json()),
  at: z.iso.datetime(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

/** The largest non-streamed response the meter keeps to read its usage. */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const METERED_EVENTS = new Set(['message_start', 'message_delta', 'message_stop']);

/**
 * Reads usage from a Messages response as it passes through: a JSON body, or
 * the stream's `message_start` and final `message_delta` events. The bytes go
 * to the caller unchanged; the meter only watches them.
 */
export class UsageMeter {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private bytes = 0;
  private model: string | undefined;
  private usage: Record<string, unknown> = {};
  private complete = false;
  private overflow = false;
  constructor(private readonly streamed: boolean) {}

  push(chunk: Uint8Array) {
    if (this.overflow) return;
    this.bytes += chunk.byteLength;
    if (!this.streamed && this.bytes > MAX_JSON_BYTES) {
      this.overflow = true;
      this.buffer = '';
      return;
    }
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.streamed) this.events();
  }

  /** The body ended normally. */
  end() {
    if (this.overflow) return;
    this.buffer += this.decoder.decode();
    if (this.streamed) {
      this.buffer += '\n\n';
      this.events();
      return;
    }
    try {
      const message = JSON.parse(this.buffer) as { model?: unknown; usage?: unknown };
      if (typeof message.model === 'string') this.model = message.model;
      if (message.usage && typeof message.usage === 'object')
        this.usage = message.usage as Record<string, unknown>;
      this.complete = this.model !== undefined;
    } catch {
      // Not a message body; nothing to record.
    }
    this.buffer = '';
  }

  private events() {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) return;
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const lines = event.split(/\r?\n/);
      // Most events are content deltas; only these three carry usage, so the
      // rest are skipped without parsing their JSON.
      const name = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      if (name !== undefined && !METERED_EVENTS.has(name)) continue;
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      let parsed: {
        type?: unknown;
        message?: { model?: unknown; usage?: unknown };
        usage?: unknown;
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.type === 'message_start') {
        if (typeof parsed.message?.model === 'string') this.model = parsed.message.model;
        if (parsed.message?.usage && typeof parsed.message.usage === 'object')
          this.usage = { ...(parsed.message.usage as Record<string, unknown>) };
      } else if (
        parsed.type === 'message_delta' &&
        parsed.usage &&
        typeof parsed.usage === 'object'
      ) {
        // The delta's counts are cumulative; a null keeps what message_start said.
        for (const [key, value] of Object.entries(parsed.usage as Record<string, unknown>))
          if (value !== null && value !== undefined) this.usage[key] = value;
      } else if (parsed.type === 'message_stop') this.complete = true;
    }
  }

  /** What was seen, or undefined when the response named no model (nothing to record). */
  report(id: string, providerRequestId: string | null, cut: boolean): UsageReport | undefined {
    if (!this.model) return undefined;
    const usage = jsonValue(this.usage) as UsageReport['usage'];
    return {
      id,
      model: this.model.slice(0, 200),
      providerRequestId: providerRequestId?.slice(0, 200) ?? null,
      partial: cut || !this.complete,
      inputTokens: count(this.usage.input_tokens),
      outputTokens: count(this.usage.output_tokens),
      cacheReadTokens: count(this.usage.cache_read_input_tokens),
      cacheWriteTokens: count(this.usage.cache_creation_input_tokens),
      usage,
      at: new Date().toISOString(),
    };
  }
}

/**
 * Writes one usage row. Every ID comes from the model token. `ai_usage.id` is
 * unique, so a repeated report is a no-op; a workspace deleted meanwhile is
 * one too.
 */
export async function recordUsage(sql: Sql, claims: ModelClaims, report: UsageReport) {
  try {
    await inWorkspace(sql, claims.workspaceId, async (tx) => {
      await tx`insert into ai_usage(id,workspace_id,kind,installation_id,registration_id,release_digest,
        function_id,job_id,attempt,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
        usage,provider_request_id,partial,created_at)
        values(${report.id},${claims.workspaceId},${claims.kind},${claims.installationId},${claims.registrationId},
          ${claims.releaseDigest},${claims.functionId},${claims.jobId},${claims.attempt},${report.model},
          ${report.inputTokens},${report.outputTokens},${report.cacheReadTokens},${report.cacheWriteTokens},
          ${tx.json(report.usage)},${report.providerRequestId},${report.partial},${report.at})
        on conflict (id) do nothing`;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return;
    throw error;
  }
}

/** Totals per UTC day across every workspace, for the operator. Run as the owner role. */
export async function dailyUsage(owner: Sql, days: number) {
  const rows = await owner<
    {
      day: string;
      kind: string;
      requests: number;
      input: string;
      output: string;
      cache_read: string;
      cache_write: string;
    }[]
  >`select to_char(date_trunc('day',created_at at time zone 'UTC'),'YYYY-MM-DD') as day,kind,count(*)::int as requests,
      sum(input_tokens)::text as input,sum(output_tokens)::text as output,
      sum(cache_read_tokens)::text as cache_read,sum(cache_write_tokens)::text as cache_write
    from ai_usage where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'-${days - 1}*interval '1 day'
    group by 1,2 order by 1,2`;
  return rows.map((row) => ({
    day: row.day,
    kind: row.kind,
    requests: row.requests,
    inputTokens: Number(row.input),
    outputTokens: Number(row.output),
    cacheReadTokens: Number(row.cache_read),
    cacheWriteTokens: Number(row.cache_write),
  }));
}
