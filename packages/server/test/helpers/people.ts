import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { lookupAccountSession } from '../../src/auth/account-session.js';
import { createApiKey } from '../../src/auth/keys.js';
import { lookupKey } from '../../src/auth/session.js';
import type { Caller } from '../../src/caller.js';
import type { Sql } from '../../src/db/client.js';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import type { TestDatabase } from './db.js';

/**
 * People in accounts mode for personal memory tests (personal memory spec
 * 6): real users, organization and workspace roles, sessions and API keys,
 * so every caller goes through the same lookups and re-checks as a request.
 */

export const SESSION_SECRET = 'personal-memory-test-secret-0123456789abcdef';

export type Person = { id: string; name: string; email: string };

export async function addPerson(db: TestDatabase, name: string): Promise<Person> {
  const id = randomUUID();
  const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@acme.test`;
  await db.owner`
    insert into users (id, name, email, email_verified) values (${id}, ${name}, ${email}, true)`;
  return { id, name, email };
}

/** A signed-in person's caller in one workspace, through `retainer_session_access`. */
export async function sessionCaller(
  db: TestDatabase,
  app: Sql,
  person: Person,
  workspaceId: string,
): Promise<Caller> {
  const token = randomBytes(24).toString('hex');
  await db.owner`
    insert into sessions (token, user_id, expires_at)
    values (${token}, ${person.id}, now() + interval '1 day')`;
  const signature = createHmac('sha256', SESSION_SECRET).update(token).digest('base64');
  return lookupAccountSession(app, {
    cookie: `${token}.${signature}`,
    secret: SESSION_SECRET,
    workspace: workspaceId,
  });
}

/** An agent key's caller, made the way the web app makes one, optionally working for a person. */
export async function keyCaller(
  db: TestDatabase,
  app: Sql,
  workspaceId: string,
  options: { worksFor?: Person; name?: string; actor?: Actor } = {},
): Promise<Caller & { key: string; keyId: string }> {
  const name = options.name ?? `agent-${randomBytes(3).toString('hex')}`;
  const created = await createApiKey(db.owner, {
    workspace: workspaceId,
    name,
    actor: options.actor ?? { type: 'agent', id: name, name },
    scopes: ['read', 'write', 'schema:write'],
    ...(options.worksFor
      ? { createdByUser: options.worksFor.id, actsForUser: options.worksFor.id }
      : {}),
  });
  return { ...(await lookupKey(app, created.key)), key: created.key, keyId: created.id };
}

export type Team = {
  organizationId: string;
  workspaceId: string;
  /** A second workspace of the same organization. */
  otherWorkspaceId: string;
  owner: Person;
  admin: Person;
  dana: Person;
  eli: Person;
  viewer: Person;
};

/**
 * An organization with two workspaces: an owner, a workspace admin, two
 * editors (Dana and Eli) and a viewer, all in both workspaces.
 */
export async function team(db: TestDatabase): Promise<Team> {
  const suffix = randomBytes(4).toString('hex');
  const organizationId = (await createOrganization(db.owner, { name: `Acme ${suffix}` })).id;
  const workspace = (name: string) =>
    createWorkspace(db.owner, {
      name,
      slug: `${name.toLowerCase()}-${suffix}`,
      organization: organizationId,
      template: 'sales',
    });
  const workspaceId = (await workspace('Sales')).id;
  const otherWorkspaceId = (await workspace('Support')).id;
  const owner = await addPerson(db, 'Owner');
  const admin = await addPerson(db, 'Admin');
  const dana = await addPerson(db, 'Dana');
  const eli = await addPerson(db, 'Eli');
  const viewer = await addPerson(db, 'Viewer');
  await setOrganizationMember(db.owner, {
    organization: organizationId,
    email: owner.email,
    role: 'owner',
  });
  const roles = [
    [admin, 'admin'],
    [dana, 'editor'],
    [eli, 'editor'],
    [viewer, 'viewer'],
  ] as const;
  for (const [person, role] of roles) {
    await setOrganizationMember(db.owner, {
      organization: organizationId,
      email: person.email,
      role: 'member',
    });
    for (const id of [workspaceId, otherWorkspaceId]) {
      await setWorkspaceMember(db.owner, { workspace: id, email: person.email, role });
    }
  }
  return { organizationId, workspaceId, otherWorkspaceId, owner, admin, dana, eli, viewer };
}
