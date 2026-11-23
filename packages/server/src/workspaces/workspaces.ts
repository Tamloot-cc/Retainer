import type { Sql } from '../db/client.js';
import { inWorkspaceTransaction } from '../db/tx.js';
import { getWorkspace, type Workspace } from '../db/workspaces.js';
import { AppError } from '../errors.js';
import { SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { applyTemplate, seedWorkspace } from '../templates/apply.js';
import { organizationForNewWorkspace } from './organizations.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Creates a workspace with its internal types and, optionally, a template, in
 * an organization: the one named (ID or exact name), or `Default`. An
 * operator operation (7.1): `sql` connects as the migration role, since the
 * runtime role cannot create workspaces.
 */
export async function createWorkspace(
  sql: Sql,
  input: { name: string; slug?: string; template?: string; organization?: string },
): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid_request', 'a workspace needs a name');
  const slug = input.slug ?? slugify(name);
  if (!SLUG_PATTERN.test(slug)) {
    throw new AppError(
      400,
      'invalid_request',
      `slug "${slug}" must be lowercase letters and digits separated by hyphens`,
    );
  }

  const workspaceId = await sql.begin(async (tx) => {
    const organization = await organizationForNewWorkspace(tx, input.organization);
    const [row] = await tx<{ id: string }[]>`
      insert into workspaces (organization_id, slug, name)
      values (${organization.id}, ${slug}, ${name})
      on conflict (slug) do nothing returning id`;
    if (!row) {
      throw new AppError(409, 'slug_taken', `a workspace with slug "${slug}" already exists`);
    }
    const workspaceId = row.id;
    await inWorkspaceTransaction(tx, workspaceId, async (scoped) => {
      await seedWorkspace(scoped, workspaceId);
      if (input.template) {
        await applyTemplate(scoped, {
          workspaceId,
          actor: SYSTEM_ACTOR,
          scopes: ['schema:write'],
          name: input.template,
          trusted: true,
        });
      }
    });
    return workspaceId;
  });

  return getWorkspace(sql, workspaceId);
}
