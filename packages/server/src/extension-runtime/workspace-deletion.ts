import type { Sql } from '../db/client.js';
import { lockSchemaShared, type Tx } from '../db/tx.js';
import { type RuntimeCatalog, resolveRelease } from './availability.js';
import { cancelRuns, lockExtension } from './locks.js';
import { ExtensionQueue } from './queue.js';

type Pin = {
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  state: string;
};

/**
 * Uninstalls every installation of a workspace being deleted (extensions spec
 * 7, review R7), with an admin uninstall's semantics: runs are cancelled, the
 * generation and grant generation advance (so run tokens, standalone keys and
 * installation OAuth grants stop working, and stay stopped if the deletion is
 * undone), webhook bindings retire and secrets are retired for collection.
 *
 * A hosted release gets `uninstalling` with the usual 24-hour cleanup deadline
 * and its cleanup job queued, so it can unregister provider webhooks and
 * subscriptions. A standalone release has nothing to clean up and becomes
 * `uninstalled`. Without a catalog, or when this process cannot resolve the
 * release, the installation still becomes `uninstalling`: a worker's
 * maintenance pass queues its cleanup (or finishes a standalone one), and the
 * deadline bounds it either way.
 *
 * `tx` is scoped to the workspace as the runtime role. Returns how many
 * installations it moved. Installations already uninstalling or uninstalled
 * are left as they are.
 */
export async function uninstallForWorkspaceDeletion(
  tx: Tx,
  workspace: string,
  options: { sql: Sql; catalog?: RuntimeCatalog | undefined },
): Promise<number> {
  await lockSchemaShared(tx, workspace);
  const candidates = await tx<{ id: string; registration_id: string }[]>`
    select id,registration_id from extension_installations
    where workspace_id=${workspace} and state not in ('uninstalling','uninstalled')
    order by registration_id`;
  let moved = 0;
  for (const candidate of candidates) {
    // The same lock order as an admin transition: schema, then the installation.
    await lockExtension(tx, workspace, candidate.registration_id);
    const [current] = await tx<Pin[]>`
      select id,registration_id,version,release_digest,state from extension_installations
      where id=${candidate.id}`;
    if (!current || ['uninstalling', 'uninstalled'].includes(current.state)) continue;
    const resolution = options.catalog ? resolveRelease(options.catalog, current) : undefined;
    const execution = resolution?.available ? resolution.manifest.execution : undefined;
    const next = execution === 'standalone' ? 'uninstalled' : 'uninstalling';
    await cancelRuns(tx, current.id);
    await tx`update extension_installations set state=${next},last_error=null,
      cleanup_deadline=case when ${next}='uninstalling' then clock_timestamp()+interval '24 hours' else null end,
      generation=generation+1,grant_generation=grant_generation+1,updated_at=now()
      where id=${current.id}`;
    await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${current.id} and state<>'retired'`;
    await tx`select retainer_retire_extension_secrets(${current.id}::uuid)`;
    if (execution === 'hosted' && options.catalog)
      await new ExtensionQueue(options.sql, options.catalog).enqueueLifecycle(
        tx,
        workspace,
        current.id,
        'uninstall',
      );
    moved++;
  }
  return moved;
}
