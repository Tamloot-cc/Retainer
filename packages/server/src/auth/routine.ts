import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockSchemaShared } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import { admitRoutine } from '../routine-runtime/admission.js';

/** Where a routine token is accepted: the routine runtime routes and nothing else. */
export const ROUTINE_RUNTIME_PREFIX = '/v1/routines/runtime/';

/**
 * A routine run's credential (routines spec §3.3). It opens only the routine
 * runtime routes, which number every effect and read records by field key;
 * the rest of the API (schema, extensions, members, routines, personal
 * memory) refuses it.
 */
export async function authenticateRoutine(
  sql: Sql,
  tokens: RunTokens,
  token: string,
  path: string,
): Promise<Caller> {
  const { workspaceId, binding } = await tokens.verifyRoutine(token);
  if (!path.startsWith(ROUTINE_RUNTIME_PREFIX))
    throw new AppError(403, 'forbidden', 'a routine credential reaches the routine runtime only');
  const routine = { ...binding };
  return inWorkspace(sql, workspaceId, async (tx) => {
    await lockSchemaShared(tx, workspaceId);
    const authority = await admitRoutine(tx, workspaceId, routine);
    return { workspaceId, ...authority, routine };
  });
}
