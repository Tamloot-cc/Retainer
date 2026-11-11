import type { Caller } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { FieldState } from '../schema/types.js';

/** Called while the record is locked. File row locks serialize attachment against orphan collection. */
export async function validateFileReferences(
  tx: Tx,
  context: Pick<Caller, 'actor' | 'run' | 'installation'> & { sourceItemId?: string },
  recordId: string,
  writes: ReadonlyMap<FieldState, unknown>,
) {
  const ids = [
    ...new Set(
      [...writes]
        .filter(([field]) => field.type === 'files')
        .flatMap(([, value]) => (Array.isArray(value) ? (value as string[]) : [])),
    ),
  ].sort();
  if (!ids.length) return;
  const [record] =
    await tx`select id from records where id=${recordId} and private_to_user is null`;
  if (!record)
    throw new AppError(422, 'invalid_files', 'personal-memory file attachments are not supported');
  const rows = await tx<
    {
      id: string;
      state: string;
      installation_id: string | null;
      source_item_id: string | null;
      created_by: { type: string; id: string };
    }[]
  >`
    select id,state,installation_id,source_item_id,created_by from files where id=any(${ids}::uuid[]) order by id for share`;
  for (const id of ids) {
    const file = rows.find((row) => row.id === id);
    if (file?.state !== 'ready')
      throw new AppError(
        422,
        'invalid_files',
        'file must be finalized and ready in this workspace',
        { fileId: id },
      );
    if (context.run || context.installation) {
      if (file.source_item_id && file.source_item_id !== context.sourceItemId)
        throw new AppError(
          403,
          'forbidden',
          'managed source uploads may be attached only to their source revision',
        );
      if (
        file.installation_id !==
        (context.run?.installationId ?? context.installation?.installationId)
      )
        throw new AppError(
          403,
          'forbidden',
          'a run can attach only files owned by its installation',
        );
    } else if (
      file.installation_id !== null ||
      file.created_by.type !== context.actor.type ||
      file.created_by.id !== context.actor.id
    ) {
      // A shared attachment may be reused by another authorized workspace member,
      // but an unbound upload is private to its creator until first attachment.
      const [visible] =
        await tx`select f.file_id from file_references f join field_assertions a on a.id=f.assertion_id join records r on r.id=a.record_id
        where f.file_id=${id} and r.deleted_at is null and r.merged_into_id is null limit 1`;
      if (!visible)
        throw new AppError(403, 'forbidden', 'unattached upload belongs to another credential');
    }
  }
}
export async function attachFileReferences(
  tx: Tx,
  workspace: string,
  assertionId: string,
  field: FieldState,
  value: unknown,
) {
  if (field.type !== 'files' || !Array.isArray(value)) return;
  for (const id of value as string[])
    await tx`insert into file_references(workspace_id,file_id,assertion_id)
    values(${workspace},${id},${assertionId}) on conflict do nothing`;
}
