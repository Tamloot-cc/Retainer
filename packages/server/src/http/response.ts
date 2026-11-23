import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Caller } from '../caller.js';
import { isWriterAdmissionDenied } from '../db/writer-lease.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { SchemaValidationError } from '../schema/types.js';
import { MAINTENANCE_RETRY_SECONDS, maintenanceBody, maintenanceResponse } from './maintenance.js';

/** Hono environment: every authenticated request carries its caller. */
export type AppEnv = {
  Variables: {
    caller: Caller;
  };
};

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

/** Postgres's code for a statement cancelled, here by the statement timeout. */
const QUERY_CANCELED = '57014';

/** Maps a thrown error to the AppError the API reports. An unknown one is logged and hidden. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isWriterAdmissionDenied(error)) {
    const { code, message } = maintenanceBody.error;
    return new AppError(503, code, message, { retryAfterSeconds: MAINTENANCE_RETRY_SECONDS });
  }
  if (error instanceof SchemaValidationError) {
    return new AppError(422, 'schema_invalid', 'the schema change is invalid', {
      issues: error.issues,
    });
  }
  if ((error as { code?: unknown } | null)?.code === QUERY_CANCELED) {
    log.warn('A statement was cancelled by the statement timeout.');
    return new AppError(
      503,
      'timeout',
      'the request took too long and was stopped; narrow it (a tighter filter or fewer results) and try again',
    );
  }
  log.error(error);
  return new AppError(500, 'internal', 'internal server error');
}

/** `{ error: { code, message, details } }`, shared by REST responses and MCP tool errors. */
export function errorBody(error: AppError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function errorResponse(c: Context, error: AppError) {
  // An operation that reached its transaction may have done earlier work.
  if (error.status === 503 && error.code === 'maintenance')
    return maintenanceResponse(false, 'writes');
  const retry = error.details?.retryAfterSeconds;
  if (
    error.status === 429 &&
    typeof retry === 'number' &&
    Number.isInteger(retry) &&
    retry > 0 &&
    retry <= 3600
  )
    c.header('Retry-After', String(retry));
  return c.json(errorBody(error), error.status as ContentfulStatusCode);
}
