import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { missingScope } from '../auth/middleware.js';
import type { Caller } from '../caller.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  MAINTENANCE_RETRY_SECONDS,
  maintenanceBody,
  readOnlyViolation,
} from '../http/maintenance.js';
import { errorBody, toAppError } from '../http/response.js';

/** What every MCP tool file uses: running a call, its result and shared inputs. */

/** A successful result: the JSON as text, and as structured content; a string as plain text. */
function ok(result: object | string): CallToolResult {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

/** A tool error carrying the same body REST returns. */
function failure(error: AppError): CallToolResult {
  const body = errorBody(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** Checks the key's scope, runs the call and maps errors like REST does. */
export async function run(
  caller: Caller,
  scope: ApiKeyScope,
  fn: () => Promise<object | string>,
  isFailure: (result: object | string) => boolean = () => false,
): Promise<CallToolResult> {
  const missing = missingScope(caller, scope);
  if (missing) return failure(missing);
  try {
    const result = await fn();
    return isFailure(result) ? { ...ok(result), isError: true } : ok(result);
  } catch (error) {
    if (readOnlyViolation(error)) {
      const { code, message } = maintenanceBody.error;
      return failure(
        new AppError(503, code, message, { retryAfterSeconds: MAINTENANCE_RETRY_SECONDS }),
      );
    }
    return failure(toAppError(error));
  }
}

export const objectName = z
  .string()
  .min(1)
  .describe('Singular API name of the object, e.g. "person", as describe_schema lists it.');
