import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { CliIdentity } from '../db/cli.js';
import type { Sql } from '../db/client.js';
import { jsonValue, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { stableJson } from '../stable-json.js';
import { lockCliLogin } from './cli-logins.js';

export type CliTarget = { workspaceId: string } | { organizationId: string };
export type CliAccountDecision = CliIdentity & {
  approvalId?: string;
  workspace?: string;
  origin: string;
};
type Action = { operation: string; arguments: Record<string, unknown> };
type Approval = {
  id: string;
  login_id: string;
  user_id: string;
  machine_name: string;
  connected_at: Date;
  workspace_id: string | null;
  organization_id: string | null;
  target_name: string;
  kind: 'elevation' | 'action';
  status: 'pending' | 'approved' | 'denied' | 'used' | 'ended' | 'expired';
  action: Action;
  action_hash: string;
  result_id: string | null;
  expires_at: Date;
  server_time: Date;
};

const targetValues = (target: CliTarget) => ({
  workspace: 'workspaceId' in target ? target.workspaceId : null,
  organization: 'organizationId' in target ? target.organizationId : null,
});

const digest = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('base64url');
const actionHash = (target: CliTarget, action: Action) => digest({ target, action });
const challengeFor = ({ id, action_hash }: Approval) => digest([id, action_hash]);

function present(row: Approval) {
  const expired = row.expires_at <= row.server_time;
  return {
    id: row.id,
    kind: row.kind,
    status: expired && ['pending', 'approved'].includes(row.status) ? 'expired' : row.status,
    expiresAt: row.expires_at.toISOString(),
    action: row.action,
    resultId: row.result_id,
    ...(row.workspace_id
      ? { workspaceId: row.workspace_id }
      : { organizationId: row.organization_id }),
    targetName: row.target_name,
    machineName: row.machine_name,
    connectedAt: row.connected_at.toISOString(),
  };
}

async function createApproval(
  tx: Tx,
  identity: CliIdentity,
  target: CliTarget,
  kind: Approval['kind'],
  action: Action,
  origin: string,
) {
  const { workspace, organization } = targetValues(target);
  const id = randomUUID();
  const [row] = await tx<{ expires_at: Date }[]>`
    insert into cli_approvals (id, login_id, kind, workspace_id, organization_id, action, action_hash, expires_at)
    values (${id}, ${identity.loginId}, ${kind}, ${workspace}, ${organization},
      ${tx.json(jsonValue(action))}, ${actionHash(target, action)}, clock_timestamp() + interval '10 minutes')
    returning expires_at`;
  if (!row) throw new Error('approval was not created');
  return { id, url: `${origin}/app/cli/approve/${id}`, expiresAt: row.expires_at.toISOString() };
}

export async function startElevation(
  tx: Tx,
  identity: CliIdentity,
  target: CliTarget,
  minutes: number,
  reason: string | undefined,
  origin: string,
) {
  await lockCliLogin(tx, identity);
  return createApproval(
    tx,
    identity,
    target,
    'elevation',
    {
      operation: 'elevate',
      arguments: { minutes, ...(reason ? { reason } : {}) },
    },
    origin,
  );
}

function approvals(sql: Sql | Tx, condition: ReturnType<Sql>) {
  return sql<Approval[]>`
    select a.*, l.user_id, l.machine_name, l.created_at as connected_at, clock_timestamp() as server_time,
      coalesce(w.name, o.name) as target_name
    from cli_approvals a join cli_logins l on l.id=a.login_id and l.revoked_at is null
    left join workspaces w on w.id=a.workspace_id
    left join organizations o on o.id=a.organization_id
    where ${condition} order by a.created_at desc, a.id`;
}

export async function approvalStatus(sql: Sql, identity: CliIdentity, id: string) {
  const [approval] = await approvals(
    sql,
    sql`a.id = ${id} and l.id = ${identity.loginId} and l.user_id = ${identity.userId}`,
  );
  if (!approval) throw notFound('CLI approval');
  return present(approval);
}

export async function openElevations(sql: Sql, userId: string, loginId?: string) {
  return (
    await approvals(
      sql,
      sql`
    l.user_id = ${userId} and ${loginId ? sql`l.id = ${loginId}` : sql`true`}
    and a.kind = 'elevation' and a.status = 'approved' and a.expires_at > clock_timestamp()`,
    )
  ).map(present);
}

export async function endElevation(sql: Sql, userId: string, id: string, loginId?: string) {
  await sql.begin(async (tx) => {
    const [approval] =
      await tx`select a.id from cli_approvals a join cli_logins l on l.id=a.login_id
      where a.id=${id} and l.user_id=${userId} and ${loginId ? tx`l.id = ${loginId}` : tx`true`}
      and a.kind='elevation' for update of a`;
    if (!approval) throw notFound('active CLI elevation');
    const [row] = await tx`update cli_approvals set status='ended' where id=${id}
      and status in ('pending', 'approved') and expires_at > clock_timestamp() returning id`;
    if (!row) throw notFound('active CLI elevation');
  });
}

type Passkey = {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
};
export function enrolledPasskeys(sql: Sql | Tx, userId: string) {
  return sql<
    Passkey[]
  >`select id, credential_id, public_key, counter, transports from passkeys where user_id = ${userId}`;
}

async function browserApproval(sql: Tx | Sql, personId: string, id: string) {
  const [row] = await approvals(sql, sql`a.id = ${id}`);
  if (!row) throw notFound('CLI approval');
  if (row.user_id !== personId) throw forbidden('This request is for another account.');
  return row;
}

export async function approvalForBrowser(sql: Sql, personId: string, id: string, origin: string) {
  const row = await browserApproval(sql, personId, id);
  const keys = await enrolledPasskeys(sql, personId);
  return {
    ...present(row),
    passkey: keys.length
      ? {
          challenge: challengeFor(row),
          rpId: new URL(origin).hostname,
          allowCredentials: keys.map((key) => ({ id: key.credential_id, type: 'public-key' })),
          userVerification: 'required',
        }
      : null,
  };
}

export async function verifyStepUp(
  tx: Tx,
  userId: string,
  origin: string,
  challenge: string,
  assertion: AuthenticationResponseJSON,
  keys: Passkey[],
) {
  const credential = keys.find((key) => key.credential_id === assertion.id);
  if (!credential) throw forbidden('Use a passkey enrolled on this account.');
  const result = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: new URL(origin).hostname,
    requireUserVerification: true,
    credential: {
      id: credential.credential_id,
      publicKey: Buffer.from(credential.public_key, 'base64'),
      counter: credential.counter,
    },
  }).catch(() => null);
  if (!result?.verified) throw forbidden('The passkey could not verify this request.');
  await tx`update passkeys set counter = greatest(counter, ${result.authenticationInfo.newCounter})
    where id = ${credential.id} and user_id = ${userId}`;
}

export async function decideApproval(
  sql: Sql,
  session: { user: { id: string }; session: { id: string } },
  id: string,
  allow: boolean,
  origin: string,
  assertion?: AuthenticationResponseJSON,
) {
  const subject = session.user.id;
  return sql.begin(async (tx) => {
    const row = await browserApproval(tx, subject, id);
    await lockCliLogin(tx, { loginId: row.login_id, userId: subject });
    // A row whose lock is released without a write need not have its UPDATE
    // predicate re-evaluated by Postgres. Take the lock before checking time.
    await tx`select id from cli_approvals where id=${id} for update`;
    if (allow) {
      await tx`select id from users where id = ${subject} for update`;
      const keys = await enrolledPasskeys(tx, subject);
      if (keys.length) {
        if (!assertion)
          throw new AppError(403, 'passkey_required', 'Verify this request with a passkey.');
        await verifyStepUp(tx, subject, origin, challengeFor(row), assertion, keys);
      } else {
        const [fresh] =
          await tx`select id from sessions where id = ${session.session.id} and user_id = ${subject}
          and expires_at > clock_timestamp() and created_at > clock_timestamp() - interval '12 hours' for share`;
        if (!fresh)
          throw new AppError(403, 'sign_in_required', 'Sign in again to approve this request.');
      }
    }
    const minutes = row.kind === 'elevation' ? Number(row.action.arguments.minutes) : 10;
    const [written] = await tx`update cli_approvals set
      status = ${allow ? 'approved' : 'denied'}, decided_at = clock_timestamp(), decided_by = ${subject},
      expires_at = case when ${allow} then clock_timestamp() + make_interval(mins => ${minutes}) else expires_at end
      where id = ${row.id} and status = 'pending' and expires_at > clock_timestamp()
      returning id`;
    if (!written)
      throw new AppError(409, 'approval_closed', 'This request was already decided or expired.');
    return { status: allow ? 'approved' : 'denied' };
  });
}

export async function accountElevation(
  tx: Tx,
  binding: CliAccountDecision | undefined,
  target: CliTarget,
) {
  if (!binding) return;
  const { workspace, organization } = targetValues(target);
  if (binding.workspace && binding.workspace !== workspace)
    throw new AppError(
      400,
      'wrong_workspace',
      'The workspace header does not match the route target.',
    );
  await lockCliLogin(tx, binding);
  const [row] = await tx<{ expires_at: Date }[]>`
    select expires_at from cli_approvals where login_id = ${binding.loginId}
      and workspace_id is not distinct from ${workspace}::uuid
      and organization_id is not distinct from ${organization}::uuid
      and kind = 'elevation' and status = 'approved' and expires_at > clock_timestamp()
    order by expires_at desc, id limit 1 for share`;
  const [checked] = await tx<
    { allowed: boolean }[]
  >`select ${row?.expires_at ?? null}::timestamptz > clock_timestamp() as allowed`;
  if (!checked?.allowed)
    throw new AppError(403, 'elevation_required', 'Ask your person to elevate for this decision.');
}

class ConfirmationRequired extends AppError {
  constructor(approval: Record<string, unknown>) {
    super(409, 'confirmation_required', 'Ask your person to approve this action.', approval);
  }
}

/** Commit the newly created request while unwinding before the protected write. */
export async function cliDecisionTransaction<T>(sql: Sql, run: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    try {
      return { value: await run(tx) };
    } catch (error) {
      if (error instanceof ConfirmationRequired) return { error };
      throw error;
    }
  });
  if ('error' in result && result.error) throw result.error;
  return result.value as T;
}

export async function confirmAction(
  tx: Tx,
  binding: CliAccountDecision | undefined,
  target: CliTarget,
  action: Action,
) {
  if (!binding) return;
  const { workspace, organization } = targetValues(target);
  if (binding.workspace && binding.workspace !== workspace)
    throw new AppError(
      400,
      'wrong_workspace',
      'The workspace header does not match the route target.',
    );
  await lockCliLogin(tx, binding);
  if (!binding.approvalId)
    throw new ConfirmationRequired(
      await createApproval(tx, binding, target, 'action', action, binding.origin),
    );
  await tx`select id from cli_approvals where id=${binding.approvalId} and login_id=${binding.loginId} for update`;
  const [used] = await tx`update cli_approvals set status = 'used'
    where id = ${binding.approvalId} and login_id = ${binding.loginId}
      and workspace_id is not distinct from ${workspace}::uuid
      and organization_id is not distinct from ${organization}::uuid
      and kind = 'action' and status = 'approved' and expires_at > clock_timestamp()
      and action_hash = ${actionHash(target, action)} returning id`;
  if (!used)
    throw new AppError(409, 'approval_invalid', 'Ask for a new confirmation of this exact action.');
}

export async function endTargetApprovals(tx: Tx, userId: string, target: CliTarget) {
  const { workspace, organization } = targetValues(target);
  await tx`update cli_approvals a set status = 'ended' from cli_logins l
    where l.id = a.login_id and l.user_id = ${userId}
    and a.workspace_id is not distinct from ${workspace}::uuid
    and a.organization_id is not distinct from ${organization}::uuid
    and a.status in ('pending', 'approved') and a.expires_at > clock_timestamp()`;
}
