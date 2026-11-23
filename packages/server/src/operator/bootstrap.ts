import { createApiKey } from '../auth/keys.js';
import type { Sql } from '../db/client.js';
import { createWorkspace } from '../workspaces/workspaces.js';

/** Session advisory lock so concurrent first boots create one workspace. */
const BOOTSTRAP_LOCK = 0x52544e01;

export type FirstBoot = { workspaceSlug: string; keyId: string; key: string };

/**
 * A self-hosted install starts with one default workspace and an admin key
 * (7). Runs on every boot and does nothing once any workspace exists.
 * `sql` must connect as the migration role with `max: 1`, so the session
 * lock and the writes share one connection.
 */
export async function bootstrap(sql: Sql): Promise<FirstBoot | null> {
  await sql`select pg_advisory_lock(${BOOTSTRAP_LOCK})`;
  try {
    const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
      select count(*)::int as count from workspaces`;
    if (count > 0) return null;
    const workspace = await createWorkspace(sql, { name: 'Default', slug: 'default' });
    const key = await createApiKey(sql, {
      workspace: workspace.id,
      name: 'Admin (created on first boot)',
      actor: { type: 'user', id: 'admin', name: 'Administrator' },
      scopes: ['read', 'write', 'schema:write', 'admin'],
    });
    return { workspaceSlug: workspace.slug, keyId: key.id, key: key.key };
  } finally {
    await sql`select pg_advisory_unlock(${BOOTSTRAP_LOCK})`;
  }
}

export function firstBootBanner(boot: FirstBoot): string {
  return [
    '',
    '================================================================',
    ' Retainer first boot: created the "default" workspace.',
    ' Admin API key (shown once; only its hash is stored):',
    '',
    `   ${boot.key}`,
    '',
    ' Create keys for your agents with:',
    '   retainer-ops key create --workspace default --name <name> \\',
    '     --actor agent:<id> --scopes read,write,schema:write',
    '================================================================',
    '',
  ].join('\n');
}
