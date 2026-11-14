import { lockSchemaShared, type Tx } from '../db/tx.js';
import { type RuntimeCatalog, resolveRelease } from './availability.js';
import { disconnectConnection } from './connections.js';
import { cancelRuns, lockExtension } from './locks.js';

type Pin = {
  id: string;
  registration_id: string;
  version: string;
  release_digest: string;
  state: string;
  generation: number;
};

/**
 * Uninstalls every installation of a workspace being deleted (extensions spec
 * 7, review R7), with an admin uninstall's semantics: runs are cancelled, the
 * generation and grant generation advance (so run tokens, standalone keys and
 * installation OAuth grants stop working, and stay stopped if the deletion is
 * undone), webhook bindings retire and secrets are retired for collection.
 *
 * A standalone release has nothing to clean up and becomes `uninstalled`.
 * Anything else becomes `uninstalling` with the usual 24-hour cleanup deadline.
 * The process deleting a workspace does not know which executables are
 * deployed, so it queues no cleanup: the executor's maintenance pass does
 * (ExtensionQueue.startCleanup), or uninstalls directly when the release has
 * no active executable, as an admin uninstall would.
 *
 * `tx` is scoped to the workspace as the runtime role. Returns how many
 * installations it moved. Installations already uninstalling or uninstalled
 * are left as they are.
 */
export async function uninstallForWorkspaceDeletion(
  tx: Tx,
  workspace: string,
  catalog?: RuntimeCatalog,
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
      select id,registration_id,version,release_digest,state,generation from extension_installations
      where id=${candidate.id}`;
    if (!current || ['uninstalling', 'uninstalled'].includes(current.state)) continue;
    const resolution = catalog ? resolveRelease(catalog, current) : undefined;
    const next =
      current.state === 'configuring' ||
      (resolution?.available && resolution.manifest.execution === 'standalone')
        ? 'uninstalled'
        : 'uninstalling';
    await cancelRuns(tx, current.id, current.generation + 1);
    await tx`update extension_installations set state=${next},last_error=null,
      cleanup_deadline=case when ${next}='uninstalling' then clock_timestamp()+interval '24 hours' else null end,
      generation=generation+1,grant_generation=grant_generation+1,updated_at=now()
      where id=${current.id}`;
    const connections =
      await tx`select id from extension_connections where installation_id=${current.id} and state<>'disconnected' order by id`;
    for (const c of connections) await disconnectConnection(tx, workspace, c.id);
    await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${current.id} and state<>'retired'`;
    await tx`select retainer_retire_extension_secrets(${current.id}::uuid)`;
    await tx`delete from extension_suggestions where installation_id=${current.id}`;
    await tx`delete from extension_access_approvals where installation_id=${current.id}`;
    if (current.state === 'configuring') {
      await tx`delete from extension_kv where installation_id=${current.id}`;
      await tx`delete from extension_jobs where installation_id=${current.id}`;
      await tx`select retainer_finish_extension_cleanup(${current.id}::uuid)`;
    }
    moved++;
  }
  return moved;
}
