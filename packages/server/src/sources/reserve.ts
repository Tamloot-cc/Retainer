import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { isEventIdentitySuppressed } from '../privacy/suppression.js';
import { sourceIdentityChannel } from './policy.js';

export type SourceIdentityBinding = {
  account_id: string;
  registration_id: string;
  provider: string;
  namespace: string;
};
/** Caller already holds privacy/schema/installation admission. Reused inside atomic webhook acceptance. */
export async function reserveSourceItem(
  tx: Tx,
  workspace: string,
  binding: SourceIdentityBinding,
  externalId: string,
) {
  const channel = sourceIdentityChannel(
    binding.registration_id,
    binding.provider,
    binding.namespace,
  );
  if (await isEventIdentitySuppressed(tx, workspace, channel, externalId))
    throw new AppError(
      409,
      'source_erased',
      'this source identity was erased and cannot be imported again',
    );
  const [item] = await tx<
    {
      id: string;
      account_id: string;
      external_id: string | null;
      state: string;
      provider_revision: string | null;
    }[]
  >`insert into source_items(workspace_id,account_id,external_id)
    values(${workspace},${binding.account_id},${externalId})
    on conflict(workspace_id,account_id,external_id) do update set external_id=excluded.external_id returning *`;
  if (!item) throw new Error('source item insert returned no row');
  if (item.state === 'erased' || !item.external_id)
    throw new AppError(
      409,
      'source_erased',
      'this source identity was erased and cannot be imported again',
    );
  return item;
}
