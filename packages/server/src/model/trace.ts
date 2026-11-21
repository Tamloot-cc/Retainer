import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';
import type { ModelClaims } from '../extension-runtime/tokens.js';
import { capturedPayloadSchema, ownerOf } from './capture.js';

const model = z.string().min(1).max(200).nullable();
const start = z.strictObject({
  type: z.literal('model_call'),
  id: z.uuid(),
  requestedModel: model,
  startedAt: z.iso.datetime(),
});
export const modelTraceSchema = z.discriminatedUnion('outcome', [
  start.extend({ outcome: z.literal('started') }),
  start.extend({
    outcome: z.enum(['completed', 'provider_error', 'transport_error', 'stream_interrupted']),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0).max(2147483647),
    returnedModel: model,
    providerRequestId: z.string().max(200).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable(),
    payload: capturedPayloadSchema.optional(),
  }),
]);
export type ModelTrace = z.infer<typeof modelTraceSchema>;
export type RecordTrace = (token: string, claims: ModelClaims, report: ModelTrace) => Promise<void>;

/** Immutable attribution and the first terminal outcome win, irrespective of delivery order. */
export async function recordTrace(sql: Sql, claims: ModelClaims, report: ModelTrace) {
  const routine = claims.kind === 'routine';
  const owner = ownerOf(claims);
  const terminal = report.outcome === 'started' ? null : report;
  try {
    await inWorkspace(sql, claims.workspaceId, async (tx) => {
      await tx`insert into model_calls
        (workspace_id,id,owner_kind,owner_id,attempt,routine_id,release_digest,function_id,
          provider,requested_model,started_at,outcome,finished_at,duration_ms,returned_model,provider_request_id,http_status,code)
        values (${claims.workspaceId},${report.id},${owner.kind},
          ${owner.id},${claims.attempt},${routine ? claims.routineId : null},
          ${routine ? null : claims.releaseDigest},${routine ? null : claims.functionId},
          'anthropic',${routine ? claims.model : report.requestedModel},${report.startedAt},${report.outcome},
          ${terminal?.finishedAt ?? null},${terminal?.durationMs ?? null},${terminal?.returnedModel ?? null},
          ${terminal?.providerRequestId ?? null},${terminal?.httpStatus ?? null},${terminal?.code ?? null})
        on conflict (workspace_id,id) do update set
          outcome=excluded.outcome, finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
          returned_model=excluded.returned_model, provider_request_id=excluded.provider_request_id,
          http_status=excluded.http_status, code=excluded.code
        where model_calls.outcome='started' and excluded.outcome<>'started'
          and model_calls.owner_kind=excluded.owner_kind and model_calls.owner_id=excluded.owner_id
          and model_calls.attempt=excluded.attempt`;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return; // Workspace removed.
    throw error;
  }

  if (terminal?.payload) {
    const payload = terminal.payload;
    await inWorkspace(sql, claims.workspaceId, async (tx) => {
      await tx`insert into model_call_payloads
        (workspace_id,call_id,request_body,response_body,request_truncated,response_truncated,response_partial,expires_at)
        select workspace_id,id,${Buffer.from(payload.requestBody, 'base64')},${Buffer.from(payload.responseBody, 'base64')},
          ${payload.requestTruncated},${payload.responseTruncated},${payload.responsePartial},
          started_at + interval '7 days'
        from model_calls where workspace_id=${claims.workspaceId} and id=${report.id}
          and owner_kind=${owner.kind}
          and owner_id=${owner.id} and attempt=${claims.attempt}
          and outcome<>'started' and started_at + interval '7 days' > now()
        on conflict do nothing`;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== '23503') throw error;
    });
  }
}
