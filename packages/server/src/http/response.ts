import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Caller } from '../caller.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { SchemaValidationError } from '../schema/types.js';

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
  return c.json(errorBody(error), error.status as ContentfulStatusCode);
}
