import type { Sql } from '../db/client.js';
import { inWorkspaceTransaction, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { lockExtension } from '../extension-runtime/locks.js';
import { ExtensionCatalog } from '../extensions/catalog.js';
import { lockWorkspaceOrganization } from '../workspaces/organizations.js';
import { type Person, workspaceAccess } from './people.js';

type Installation = {
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  generation: number;
  state: string;
  granted_actor: 'integration' | 'agent';
  granted_scopes: ('read' | 'write')[];
};
type RequestGrant = { clientId: string; scopes: ('read' | 'write')[] };

/** These parameters remain untrusted until Better Auth verifies the whole signed query. */
export function installationRequest(query: string, origin: string): RequestGrant | null {
  const params = new URLSearchParams(query),
    resources = params.getAll('resource');
  if (resources.length === 0 || (resources.length === 1 && resources[0] === `${origin}/mcp`))
    return null;
  if (resources.length !== 1 || resources[0] !== `${origin}/v1`)
    throw new AppError(400, 'invalid_request', 'pick exactly one OAuth resource');
  const clients = params.getAll('client_id'),
    scope = params.getAll('scope');
  const scopes = scope[0]?.split(' ').filter(Boolean) ?? [];
  if (
    clients.length !== 1 ||
    !clients[0] ||
    scope.length !== 1 ||
    !scopes.some((s) => s === 'read' || s === 'write') ||
    scopes.some((s) => !['read', 'write', 'offline_access'].includes(s)) ||
    new Set(scopes).size !== scopes.length
  )
    throw new AppError(
      400,
      'invalid_request',
      'workspace apps require explicit read or write scopes',
    );
  return {
    clientId: clients[0],
    scopes: scopes.filter((s): s is 'read' | 'write' => s === 'read' || s === 'write'),
  };
}

async function asAdmin<T>(
  sql: Sql,
  person: Person,
  workspace: string,
  clientId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await lockWorkspaceOrganization(tx, workspace);
    if ((await workspaceAccess(tx, person, workspace)).role !== 'admin')
      throw forbidden('Only a workspace admin can connect a workspace app.');
    const [client] =
      await tx`select client_id from oauth_clients where client_id=${clientId} and disabled is not true for share`;
    if (!client) throw notFound('OAuth client');
    await tx`set local role retainer_app`;
    return inWorkspaceTransaction(tx, workspace, async (scoped) => {
      await lockSchemaShared(scoped, workspace);
      return fn(scoped);
    });
  })) as T;
}

function reviewed(row: Installation, client: string, catalog: ExtensionCatalog) {
  const release = catalog.get(row.registration_id, row.version);
  return row.state === 'active' &&
    release.digest === row.release_digest &&
    release.manifest.execution === 'standalone' &&
    release.manifest.oauthClientId === client
    ? release
    : null;
}

export async function installationOptions(
  sql: Sql,
  person: Person,
  workspace: string,
  clientId: string,
  catalog = new ExtensionCatalog(),
) {
  return asAdmin(sql, person, workspace, clientId, async (tx) => {
    const rows = await tx<
      Installation[]
    >`select * from extension_installations where state='active' order by created_at,id`;
    const installations = [];
    for (const row of rows) {
      // Old or unavailable releases cannot authorize a new connection.
      const release = catalog
        .list()
        .find(
          (r) =>
            r.manifest.universalId === row.registration_id && r.manifest.version === row.version,
        );
      if (!release || !reviewed(row, clientId, catalog)) continue;
      installations.push({
        id: row.id,
        name: release.manifest.name,
        version: row.version,
        actor: row.granted_actor,
        scopes: row.granted_scopes,
        generation: row.generation,
      });
    }
    return { installations };
  });
}

/**
 * Better Auth has a separate pool. Stage an unusable reference it can see,
 * then activate only after verified consent and a second admin/generation check.
 * A crash between stages leaves a pending credential that can never authorize.
 */
export async function consentInstallation(input: {
  sql: Sql;
  person: Person;
  workspaceId: string;
  installationId: string;
  expectedGeneration: number;
  grant: RequestGrant;
  catalog?: ExtensionCatalog;
  record: (referenceId: string) => Promise<Response>;
}): Promise<Response> {
  const { sql, person, workspaceId, installationId, expectedGeneration, grant } = input;
  const catalog = input.catalog ?? new ExtensionCatalog();
  const checked = async (tx: Tx) => {
    const [candidate] = await tx<
      Installation[]
    >`select * from extension_installations where id=${installationId}`;
    if (!candidate) throw notFound('extension installation');
    await lockExtension(tx, workspaceId, candidate.registration_id);
    const [row] = await tx<
      Installation[]
    >`select * from extension_installations where id=${installationId}`;
    if (!row || row.generation !== expectedGeneration || !reviewed(row, grant.clientId, catalog))
      throw new AppError(409, 'stale_plan', 'installation changed; review the connection again');
    if (grant.scopes.some((scope) => !row.granted_scopes.includes(scope)))
      throw forbidden('requested scopes exceed the approved installation');
    return row;
  };
  const referenceId = await asAdmin(sql, person, workspaceId, grant.clientId, async (tx) => {
    const row = await checked(tx);
    // Interrupted handshakes never become active; collect their bounded-lived references.
    await tx`delete from extension_credentials where installation_id=${installationId}
      and pending and (revoked_at is not null or created_at<clock_timestamp()-interval '1 hour')`;
    const [pending] = await tx<
      { count: number }[]
    >`select count(*)::int as count from extension_credentials
      where installation_id=${installationId} and pending`;
    if ((pending?.count ?? 0) >= 20)
      throw new AppError(
        429,
        'quota_exceeded',
        'too many app connections are awaiting consent; try again later',
      );
    const [credential] = await tx<{ id: string }[]>`insert into extension_credentials
      (workspace_id,installation_id,generation,kind,client_id,subject_id,scopes,created_by,pending)
      values(${workspaceId},${installationId},${row.generation},'oauth',${grant.clientId},${person.id},
        ${tx.json(grant.scopes)},${tx.json({ type: 'user', id: person.id })},true) returning id`;
    if (!credential) throw new Error('OAuth credential insert returned no row');
    await tx`insert into oauth_grant_references(id,workspace_id,kind,credential_id)
      values(${credential.id},${workspaceId},'installation',${credential.id})`;
    return credential.id;
  });
  try {
    const response = await input.record(referenceId);
    if (response.status >= 400) {
      await discardPending(sql, workspaceId, referenceId);
      return response;
    }
    await asAdmin(sql, person, workspaceId, grant.clientId, async (tx) => {
      await checked(tx);
      const [pending] =
        await tx`select id from extension_credentials where id=${referenceId} and pending and revoked_at is null for update`;
      if (!pending) throw new AppError(409, 'stale_plan', 'connection was cancelled');
      // Both replacement and explicit disconnect drain admitted app writes first.
      await tx`update extension_credentials set revoked_at=coalesce(revoked_at,clock_timestamp())
        where installation_id=${installationId} and kind='oauth' and client_id=${grant.clientId} and id<>${referenceId}`;
      await tx`delete from oauth_grant_references where kind='installation' and credential_id in
        (select id from extension_credentials where installation_id=${installationId} and kind='oauth'
          and client_id=${grant.clientId} and id<>${referenceId} and not pending)`;
      await tx`update extension_credentials set pending=false where id=${referenceId}`;
    });
    return response;
  } catch (error) {
    await discardPending(sql, workspaceId, referenceId);
    throw error;
  }
}

async function discardPending(sql: Sql, workspace: string, id: string) {
  await sql.begin(async (tx) => {
    await tx`set local role retainer_app`;
    await inWorkspaceTransaction(tx, workspace, async (scoped) => {
      // Deleting the pending credential cascades its library consent and tokens.
      await scoped`delete from extension_credentials where id=${id} and pending`;
    });
  });
}
