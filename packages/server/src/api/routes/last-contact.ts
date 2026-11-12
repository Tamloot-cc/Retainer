import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { AppError, forbidden, notFound } from '../../errors.js';
import type { ExtensionCatalog } from '../../extensions/catalog.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { reconcileLastContact } from '../../memory/last-contact.js';
import { withWrite } from '../../records/service.js';
import type { FieldState } from '../../schema/types.js';

const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('scan'),
    after: z.uuid().nullable().default(null),
    through: z.uuid().optional(),
  }),
  z.strictObject({ kind: z.literal('records'), recordIds: z.array(z.uuid()).min(1).max(20) }),
]);
/** Pinned functions may recompute only contributed fields, never supply a value, source or actor. */
export function lastContactRoutes(app: Hono<AppEnv>, sql: Sql, catalog: ExtensionCatalog) {
  app.post('/extensions/:id/runtime/last-contact', requireScope('write'), async (c) => {
    const caller = c.get('caller'),
      id = idParam(c),
      input = await readBody(c, inputSchema),
      run = caller.run;
    if (!run || run.installationId !== id) throw forbidden('live installation credential required');
    return c.json(
      await withWrite(
        sql,
        caller,
        async (tx, context) => {
          const [installation] = await tx<
            { version: string }[]
          >`select version from extension_installations where id=${id}`;
          if (!installation) throw notFound('extension installation');
          const release = catalog.get(run.registrationId, installation.version),
            policy = release.manifest.lastContact;
          const [job] = await tx`select function_id from extension_jobs where id=${run.jobId}`;
          if (
            release.digest !== run.releaseDigest ||
            !policy ||
            !policy.functionIds.includes(job?.function_id)
          )
            throw forbidden('this function has no last-contact derivation grant');
          const fields = new Map<string, FieldState>();
          for (const binding of policy.fields) {
            const object = context.schema.objectsByUniversalId.get(binding.objectId),
              field = object?.activeFields.find((entry) => entry.universalId === binding.fieldId);
            const [owned] =
              await tx`select 1 from extension_contributions where installation_id=${id} and kind='field' and universal_id=${binding.fieldId} and element_id=${field?.id ?? null}`;
            if (
              !object ||
              object.hidden ||
              object.isEvent ||
              object.state.status !== 'active' ||
              !field ||
              field.type !== 'date_time' ||
              !field.isNullable ||
              field.isUnique ||
              !owned
            )
              throw new AppError(
                409,
                'incompatible_derivation',
                'the installed last-contact field changed',
              );
            fields.set(object.id, field);
          }
          let ids: string[],
            nextAfter: string | null = null,
            through: string | null = null;
          if (input.kind === 'scan') {
            const [upper] = await tx<
              { id: string }[]
            >`select id from records where object_type_id=any(${[...fields.keys()]}::uuid[]) and deleted_at is null and merged_into_id is null and private_to_user is null order by id desc limit 1`;
            through = input.through ?? upper?.id ?? null;
            const rows = await tx<
              { id: string }[]
            >`select id from records where workspace_id=${caller.workspaceId} and object_type_id=any(${[...fields.keys()]}::uuid[])
          and private_to_user is null and deleted_at is null and merged_into_id is null and (${input.after}::uuid is null or id>${input.after}::uuid) and id<=${through}::uuid order by id limit 21`;
            ids = rows.slice(0, 20).map((row) => row.id);
            nextAfter = rows.length > 20 ? (ids.at(-1) ?? null) : null;
          } else {
            const rows = await tx<
              { id: string }[]
            >`select distinct r.id from records r where r.workspace_id=${caller.workspaceId} and r.private_to_user is null
          and r.deleted_at is null and r.merged_into_id is null and r.object_type_id=any(${[...fields.keys()]}::uuid[])
          and (r.id=any(${input.recordIds}::uuid[]) or r.id in(select l.target_record_id from record_links l where l.source_record_id=any(${input.recordIds}::uuid[]) and l.field_id=any(${context.schema.rollUpFieldIds}::uuid[]))) order by r.id limit 201`;
            if (rows.length > 200)
              throw new AppError(
                422,
                'derivation_fanout_exceeded',
                'reconcile this change with a paged scan',
              );
            ids = rows.map((row) => row.id);
          }
          let changed = 0;
          for (const recordId of ids) {
            const [record] = await tx<
              { object_type_id: string }[]
            >`select object_type_id from records where id=${recordId}`;
            const field = fields.get(record?.object_type_id ?? '');
            if (field && (await reconcileLastContact(tx, context, recordId, field)).changed)
              changed++;
          }
          return { processed: ids.length, changed, nextAfter, through };
        },
        { schema: 'exclusive' },
      ),
    );
  });
}
