import type { Caller } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

/**
 * The fields this caller may not write (extensions spec 8): those an
 * installation contributed as installation-owned, unless the caller is that
 * installation (a hosted run's or a standalone app's credential). The
 * restriction lasts while the installation does: once it is uninstalled, its
 * fields are ordinary fields again. Read in the caller's transaction, because
 * installing and uninstalling do not change the schema version.
 */
export async function readOnlyFieldsFor(
  tx: Tx,
  caller: Pick<Caller, 'run' | 'installation'>,
  fieldIds?: readonly string[],
): Promise<Set<string>> {
  if (fieldIds?.length === 0) return new Set();
  const writer = caller.run?.installationId ?? caller.installation?.installationId ?? null;
  const rows = await tx<{ element_id: string }[]>`
    select c.element_id from extension_contributions c
    join extension_installations i on i.id = c.installation_id
    where c.kind = 'field' and c.definition->>'installationOwned' = 'true'
      and i.state <> 'uninstalled'
      and c.installation_id is distinct from ${writer}::uuid
      ${fieldIds ? tx`and c.element_id = any(${[...fieldIds]}::uuid[])` : tx``}`;
  return new Set(rows.map((row) => row.element_id));
}

/** Refuses a write to a field the caller may not write. */
export function refuseOwnedWrite(
  readOnly: ReadonlySet<string>,
  fields: readonly { id?: string; name: string }[],
) {
  const field = fields.find((f) => f.id && readOnly.has(f.id));
  if (field)
    throw new AppError(
      403,
      'installation_owned',
      `${field.name} is written only by the app that added it`,
      { field: field.name },
    );
}
