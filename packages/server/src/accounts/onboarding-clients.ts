import { hostedClientId, OAUTH_SCOPES } from '@retainer/shared';
import { oauthSettings } from '../auth/oauth-token.js';
import type { Tx } from '../db/tx.js';

const CALLBACKS = ['http://127.0.0.1/callback', 'http://localhost/callback'];

/**
 * Public native clients for the copied setup prompt. The port is ephemeral,
 * as allowed by RFC 8252 for loopback IP redirects. Neither client has a
 * secret, and both use authorization code with mandatory PKCE.
 */
export async function registerOnboardingClients(tx: Tx, workspaceId: string, origin: string) {
  const { resource } = oauthSettings(origin);
  // Workspaces can be provisioned before Better Auth's first MCP discovery.
  await tx`
    insert into oauth_resources (identifier, name, created_at, updated_at)
    values (${resource}, 'Retainer', now(), now()) on conflict (identifier) do nothing`;
  for (const [kind, name] of [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
  ] as const) {
    const clientId = hostedClientId(workspaceId, kind);
    await tx`
      insert into oauth_clients (
        client_id, onboarding_workspace_id, name, application_type, redirect_uris, scopes,
        grant_types, response_types, token_endpoint_auth_method, require_pkce, created_at, updated_at
      ) values (
        ${clientId}, ${workspaceId}, ${name}, 'native', ${CALLBACKS},
        ${[...OAUTH_SCOPES, 'offline_access']}, ${['authorization_code', 'refresh_token']},
        ${['code']}, 'none', true, now(), now()
      )`;
    await tx`
      insert into oauth_client_resources (client_id, resource_id, created_at)
      values (${clientId}, ${resource}, now())`;
  }
}
