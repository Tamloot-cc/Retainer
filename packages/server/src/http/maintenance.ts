const MESSAGE = 'Retainer is updating. Please retry shortly.';
export const MAINTENANCE_RETRY_SECONDS = 5;

export type PausedOperation = 'writes' | 'reads' | 'session-refresh' | 'extensions';

export function maintenanceHeaders(notExecuted: boolean, operation?: PausedOperation) {
  return {
    'retry-after': String(MAINTENANCE_RETRY_SECONDS),
    'cache-control': 'no-store',
    ...(notExecuted ? { 'x-retainer-maintenance': 'not-executed' } : {}),
    ...(operation ? { 'x-retainer-paused-operation': operation } : {}),
  };
}

export const maintenanceBody = { error: { code: 'maintenance', message: MESSAGE } };

export function maintenanceResponse(notExecuted: boolean, operation?: PausedOperation): Response {
  return Response.json(maintenanceBody, {
    status: 503,
    headers: maintenanceHeaders(notExecuted, operation),
  });
}

/** Tagged PostgreSQL errors also travel through the query adapter's cause. */
export function readOnlyViolation(error: unknown): boolean {
  const dbError = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return dbError?.code === '25006' || dbError?.cause?.code === '25006';
}
