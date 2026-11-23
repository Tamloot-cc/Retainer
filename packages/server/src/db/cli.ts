import { AppError } from '../errors.js';
import type { Tx } from './tx.js';

export const CLI_CLIENT_ID = 'retainer-cli';
export const CLI_LOGIN_CLAIM = 'cli_login';
export const CLI_VIA = 'Retainer CLI';
export const CLI_REDIRECT = 'http://127.0.0.1/callback';

export type CliIdentity = { loginId: string; userId: string };
export type CliDecision = CliIdentity & { elevationId?: string };

/** The caller must take the decision's own locks before taking this lock. */
export async function recheckElevation(
  tx: Tx,
  cli: CliDecision | undefined,
  requiredRole: 'admin' | 'editor',
): Promise<void> {
  if (!cli) return;
  const [row] = await tx<{ allowed: boolean }[]>`
    select retainer_cli_elevation(${cli.userId}::uuid, ${cli.loginId}::uuid,
      ${cli.elevationId ?? null}::uuid, ${requiredRole}) as allowed`;
  if (!row?.allowed) {
    throw new AppError(
      403,
      'elevation_required',
      "This is your person's decision. Ask them to elevate in this workspace.",
    );
  }
}
