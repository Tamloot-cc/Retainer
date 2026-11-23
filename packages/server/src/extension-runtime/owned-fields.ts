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
  caller: Pick<Caller, 'workspaceId' | 'run' | 'installation'>,
  fieldIds?: readonly string[],
): Promise<Set<string>> {
  if (fieldIds?.length === 0) return new Set();
  const writer = caller.run?.installationId ?? caller.installation?.installationId ?? null;
  const rows = await tx<{ id: string }[]>`
    select f.id from extension_installations i
    cross join lateral jsonb_array_elements(i.bindings->'declarations') as b(binding)
    cross join lateral jsonb_array_elements(b.binding->'fields') as r(rule)
    join object_types o on o.workspace_id = i.workspace_id
      and o.universal_id::text = i.bindings #>> array['destinations', b.binding->>'key', 'objects', '0']
    join fields f on f.object_type_id = o.id
      and f.universal_id::text = i.bindings #>> array['destinations', b.binding->>'key', 'fields', r.rule->>'key', 'id']
    where i.workspace_id = ${caller.workspaceId} and i.state <> 'uninstalled'
      and r.rule->>'installationOwned' = 'true'
      and i.id is distinct from ${writer}::uuid
      ${fieldIds ? tx`and f.id = any(${[...fieldIds]}::uuid[])` : tx``}`;
  return new Set(rows.map((row) => row.id));
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
