import { randomUUID } from 'node:crypto';
import { cliOAuthSettings } from '../auth/oauth-token.js';
import { CLI_CLIENT_ID, CLI_REDIRECT, type CliIdentity } from '../db/cli.js';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';

export async function ensureCliClient(sql: Sql, publicOrigin: string) {
  const { resource } = cliOAuthSettings(publicOrigin);
  await sql.begin(async (tx) => {
    await tx`
      insert into oauth_clients (
        client_id, name, redirect_uris, application_type, token_endpoint_auth_method,
        require_pkce, grant_types, response_types, scopes, created_at, updated_at
      ) values (
        ${CLI_CLIENT_ID}, 'Retainer CLI', array[${CLI_REDIRECT}], 'native', 'none', true,
        array['authorization_code', 'refresh_token'], array['code'], array['read', 'offline_access'],
        now(), now()
      ) on conflict (client_id) do nothing`;
    await tx`
      insert into oauth_resources (identifier, name, allowed_scopes, access_token_ttl, refresh_token_ttl, created_at, updated_at)
      values (${resource}, 'Retainer CLI', array['read', 'offline_access'], 3600, 2592000, now(), now())
      on conflict (identifier) do nothing`;
    await tx`
      insert into oauth_client_resources (client_id, resource_id, created_at)
      values (${CLI_CLIENT_ID}, ${resource}, now()) on conflict (client_id, resource_id) do nothing`;
  });
}

export function cliConsent(query: string, publicOrigin: string): { machineName: string } | null {
  const params = new URLSearchParams(query);
  const client = params.get('client_id');
  const resources = params.getAll('resource');
  const resource = cliOAuthSettings(publicOrigin).resource;
  if (client !== CLI_CLIENT_ID && !resources.includes(resource)) return null;
  if (client !== CLI_CLIENT_ID || resources.length !== 1 || resources[0] !== resource)
    throw new AppError(
      400,
      'invalid_request',
      'The CLI client must request the CLI resource alone.',
    );
  const state = params.get('state') ?? '';
  const label = /^[a-zA-Z0-9_-]{32,}\.(?<label>[a-zA-Z0-9_-]{1,400})$/.exec(state)?.groups?.label;
  if (!label)
    throw new AppError(400, 'invalid_request', 'Start the connection with retainer login.');
  const machineName = Buffer.from(label, 'base64url').toString('utf8').trim();
  if (!machineName || machineName.length > 100 || /\p{Cc}/u.test(machineName))
    throw new AppError(400, 'invalid_request', 'The CLI machine name is invalid.');
  return { machineName };
}

export async function recordCliLogin(
  sql: Sql,
  userId: string,
  machineName: string,
  record: (id: string) => Promise<Response>,
): Promise<Response> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into cli_logins (id, user_id, machine_name) values (${id}, ${userId}, ${machineName})`;
    await tx`insert into oauth_grant_references (id, kind, cli_login_id) values (${id}, 'cli', ${id})`;
  });
  try {
    const response = await record(id);
    if (response.ok) return response;
    await revokeCliLogin(sql, { loginId: id, userId });
    return response;
  } catch (error) {
    await revokeCliLogin(sql, { loginId: id, userId });
    throw error;
  }
}

export async function lockCliLogin(tx: Tx, identity: CliIdentity) {
  const [row] = await tx<{ id: string }[]>`
    select l.id from cli_logins l join users u on u.id = l.user_id and u.disabled_at is null
    join oauth_clients c on c.client_id = ${CLI_CLIENT_ID} and c.disabled is not true
    where l.id = ${identity.loginId} and l.user_id = ${identity.userId} and l.revoked_at is null
    for share of l`;
  if (!row) throw new AppError(401, 'unauthorized', 'This CLI login has ended; log in again.');
}

export async function revokeCliLogin(sql: Sql, identity: CliIdentity) {
  await sql.begin(async (tx) => {
    const [row] = await tx`
      update cli_logins set revoked_at = coalesce(revoked_at, clock_timestamp())
      where id = ${identity.loginId} and user_id = ${identity.userId} returning id`;
    if (!row) throw notFound('connection');
    await tx`update cli_approvals set status = 'ended'
      where login_id = ${identity.loginId} and status in ('pending', 'approved')
        and expires_at > clock_timestamp()`;
    await tx`delete from oauth_refresh_tokens where client_id = ${CLI_CLIENT_ID}
      and user_id = ${identity.userId} and reference_id = ${identity.loginId}`;
    await tx`delete from oauth_consents where client_id = ${CLI_CLIENT_ID}
      and user_id = ${identity.userId} and reference_id = ${identity.loginId}`;
  });
}
