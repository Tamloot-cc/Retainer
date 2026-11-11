import type { Sql } from '../db/client.js';

/** Read-only deployment inventory. Returns release hashes/counts, never workspace identities or settings. */
export async function extensionReleaseStatus(sql: Sql, available: readonly string[]) {
  const [table] = await sql`select to_regclass('public.extension_installations') as name`;
  if (!table?.name) return { compatible: true, references: [], missingReleaseDigests: [] };
  // Forward bootstrap may precede the lifecycle migration that adds cleanup leases.
  const [columns] = await sql<{ cleanup: boolean }[]>`select exists(select 1 from pg_attribute
    where attrelid='public.extension_installations'::regclass and attname='cleanup_deadline' and not attisdropped) as cleanup`;
  const references = await sql<{ releaseDigest: string; installations: number }[]>`
    select release_digest as "releaseDigest",count(*)::int as installations
    from extension_installations
    where state<>'uninstalled' ${columns?.cleanup ? sql`or cleanup_deadline>clock_timestamp()` : sql``}
    group by release_digest order by release_digest`;
  const allowed = new Set(available),
    missingReleaseDigests = references
      .filter((row) => !allowed.has(row.releaseDigest))
      .map((row) => row.releaseDigest);
  return { compatible: missingReleaseDigests.length === 0, references, missingReleaseDigests };
}
