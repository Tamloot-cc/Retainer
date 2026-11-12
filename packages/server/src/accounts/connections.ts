import type { Sql } from '../db/client.js';
import { forbidden, notFound } from '../errors.js';
import { endGrants, lockWorkspaceOrganization } from '../workspaces/organizations.js';
import { type Person, workspaceAccess } from './people.js';

/**
 * Connected apps (accounts spec 4.7, 5.1): apps people connected to a
 * workspace over OAuth, such as Claude. Each is a consent row; its tokens
 * work only while it exists, so disconnecting ends the app's access at its
 * next request. `sql` connects as the control role.
 */

export type Connection = {
  id: string;
  app: { name: string; uri: string | null };
  workspace: { id: string; slug: string; name: string };
  person: { id: string; name: string; email: string };
  /** What the app asked for and the person allowed; their role caps it. */
  scopes: string[];
  connectedAt: string;
};

type ConnectionRow = {
  id: string;
  app_name: string;
  app_uri: string | null;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  user_id: string;
  user_name: string;
  user_email: string;
  scopes: string[];
  created_at: Date;
};

const toConnection = (row: ConnectionRow): Connection => ({
  id: row.id,
  app: { name: row.app_name, uri: row.app_uri },
  workspace: { id: row.workspace_id, slug: row.workspace_slug, name: row.workspace_name },
  person: { id: row.user_id, name: row.user_name, email: row.user_email },
  scopes: row.scopes.filter((s) => s !== 'offline_access'),
  connectedAt: row.created_at.toISOString(),
});

function connections(sql: Sql, where: ReturnType<Sql>) {
  return sql<ConnectionRow[]>`
    select oc.id, coalesce(c.name, c.client_id) as app_name, c.uri as app_uri,
      w.id as workspace_id, w.slug as workspace_slug, w.name as workspace_name,
      u.id as user_id, u.name as user_name, u.email as user_email,
      oc.scopes, oc.created_at
    from oauth_consents oc
    join oauth_clients c on c.client_id = oc.client_id
    join workspaces w on w.id = oc.reference_id and w.deletion_scheduled_at is null
    join users u on u.id = oc.user_id
    where ${where}
    order by oc.created_at desc, oc.id`;
}

/** A workspace's connected apps: all of them for an admin, otherwise the person's own. */
export async function listWorkspaceConnections(
  sql: Sql,
  person: Person,
  workspaceId: string,
): Promise<{ connections: Connection[] }> {
  const { role } = await workspaceAccess(sql, person, workspaceId);
  const rows = await connections(
    sql,
    role === 'admin'
      ? sql`oc.reference_id = ${workspaceId}`
      : sql`oc.reference_id = ${workspaceId} and oc.user_id = ${person.id}`,
  );
  return { connections: rows.map(toConnection) };
}

/** The apps a person connected, in every workspace (Your account). */
export async function listMyConnections(sql: Sql, person: Person): Promise<Connection[]> {
  return (await connections(sql, sql`oc.user_id = ${person.id}`)).map(toConnection);
}

/**
 * Records a person's consent to an app for one workspace (4.7), like every
 * account write: the workspace's organization lock first, then the access
 * check, then the write. `record` is Better Auth writing the consent, on its
 * own pool, while this transaction holds the lock, so a removal or a move
 * either commits first and the check refuses, or waits and then finds the
 * consent and ends it. A workspace the person cannot reach is a 404.
 */
export async function recordConsent(
  sql: Sql,
  person: Person,
  workspaceId: string,
  record: () => Promise<Response>,
): Promise<Response> {
  return (await sql.begin(async (tx) => {
    await lockWorkspaceOrganization(tx, workspaceId);
    await workspaceAccess(tx, person, workspaceId);
    return record();
  })) as Response;
}

/**
 * Disconnects an app: the person who connected it, or an admin of its
 * workspace. Takes the workspace's organization lock first, then checks the
 * role, then deletes, like every account write.
 */
export async function disconnect(
  sql: Sql,
  person: Person,
  connectionId: string,
  /** When disconnecting from a workspace's settings: the workspace it must be in. */
  inWorkspace?: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [found] = await tx<{ workspace_id: string }[]>`
      select oc.reference_id as workspace_id from oauth_consents oc
      join workspaces w on w.id=oc.reference_id where oc.id = ${connectionId}`;
    if (!found) throw notFound('connection');
    await lockWorkspaceOrganization(tx, found.workspace_id);
    const [consent] = await tx<{ user_id: string; workspace_id: string }[]>`
      select user_id, reference_id as workspace_id from oauth_consents where id = ${connectionId}`;
    if (!consent || (inWorkspace && consent.workspace_id !== inWorkspace)) {
      throw notFound('connection');
    }
    if (consent.user_id !== person.id) {
      // Someone without access to the workspace learns nothing about it.
      const { role } = await workspaceAccess(tx, person, consent.workspace_id);
      if (role !== 'admin') {
        throw forbidden('Only a workspace admin, or the person who connected it, can do this.');
      }
    }
    await endGrants(tx, tx`oc.id = ${connectionId}`);
  });
}
