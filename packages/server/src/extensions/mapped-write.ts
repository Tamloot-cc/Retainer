import { outputKeySchema } from '@retainer/extension';
import { normalizeDomain } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { withWrite } from '../records/service.js';
import { prepareValues } from '../records/values.js';
import { type LockedRecord, writeFields } from '../records/write.js';
import type { CompiledObject } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import type { ExtensionCatalog } from './catalog.js';
import { bindingStatus, EMPTY_MAPPING, type StoredMapping } from './mapping.js';

export const mappedWriteSchema = z.strictObject({
  recordId: z.uuid(),
  /** The normalized lookup value the run used, checked against the record's current one. */
  lookup: z.string().min(1).max(2048).optional(),
  /** Only outputs the run has a valid value for. */
  values: z.record(outputKeySchema, z.json()),
  observedAt: z.iso.datetime({ offset: true }).optional(),
});
export type MappedWriteInput = z.infer<typeof mappedWriteSchema>;

export type MappedWriteResult = {
  outcome: 'applied' | 'skipped';
  reason?: 'record_deleted' | 'record_merged' | 'lookup_changed' | 'nothing_to_fill';
  fields: Record<string, 'applied' | 'populated' | 'cleared' | 'pending_review'>;
};

/** The record as it is, without following a merge to its survivor. */
async function lockExact(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx<LockedRecord[]>`
    select id, object_type_id, data, updated_at, deleted_at, merged_into_id from records
    where id = ${id} and workspace_id = ${workspaceId}
    for no key update`;
  return row;
}

/** The lookup value of a record, normalized the way the run normalized it. */
function currentLookup(field: FieldState, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (field.type === 'links') {
    const url = (value as { primary?: { url?: unknown } | null }).primary?.url;
    return typeof url === 'string' ? normalizeDomain(url) : null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The fill-only mapped write (spec 3.5). Under the schema, installation and
 * record locks it resolves the approved mapping, checks that the exact record
 * is live and still has the looked-up value, and writes only targets that have
 * no value and were not explicitly cleared. Replays find their targets filled
 * and write nothing, so the endpoint is idempotent without a key.
 */
export async function mappedWrite(
  sql: Sql,
  catalog: ExtensionCatalog,
  caller: Caller,
  input: MappedWriteInput,
): Promise<MappedWriteResult> {
  const run = caller.run;
  if (!run) throw forbidden('this endpoint requires a live run credential');
  try {
    return await withWrite(sql, caller, async (tx, context) => {
      const [installation] = await tx<
        { version: string; mapping: StoredMapping }[]
      >`select version, mapping from extension_installations where id = ${run.installationId}`;
      if (!installation) throw notFound('extension installation');
      const release = catalog.get(run.registrationId, installation.version);
      const mapping = release.manifest.mapping;
      const fn = release.manifest.functions.find((f) => f.universalId === run.functionId);
      if (release.digest !== run.releaseDigest || !mapping || !fn?.mappedWrite)
        throw forbidden('this function may not write mapped outputs');
      const stored = installation.mapping?.outputs ? installation.mapping : EMPTY_MAPPING;
      const unknown = Object.keys(input.values).filter((key) => !stored.outputs[key]);
      if (unknown.length)
        throw new AppError(422, 'mapping_invalid', 'values name outputs that are not mapped', {
          outputs: unknown.map((output) => ({ output, reason: 'unknown_output' })),
        });
      const object = context.schema.objectsByUniversalId.get(mapping.objectId);
      // Installation refuses a hidden target; this guards the write path too.
      if (object?.hidden)
        throw new AppError(
          409,
          'schema_binding_conflict',
          'extensions cannot write internal memory types',
        );
      const targets = new Map<string, FieldState>();
      const conflicts: { output: string; field: string | null; reason: string }[] = [];
      for (const key of Object.keys(input.values)) {
        const output = mapping.outputs.find((o) => o.key === key);
        const binding = stored.outputs[key];
        if (!output || !binding) continue;
        const { status, field } = bindingStatus(object?.state, output, binding.fieldUniversalId);
        if (status !== 'ok' || !field)
          conflicts.push({ output: key, field: field?.name ?? null, reason: status });
        else targets.set(key, field);
      }
      if (conflicts.length || !object)
        throw new AppError(409, 'schema_binding_conflict', 'a mapped field is missing or changed', {
          outputs: conflicts,
        });
      const record = await lockExact(tx, caller.workspaceId, input.recordId);
      if (!record) throw notFound('record', { id: input.recordId });
      if (record.object_type_id !== object.id)
        throw new AppError(422, 'invalid_request', `record is not a ${object.name}`);
      const skip = (reason: MappedWriteResult['reason']): MappedWriteResult => ({
        outcome: 'skipped',
        ...(reason ? { reason } : {}),
        fields: {},
      });
      if (record.merged_into_id) return skip('record_merged');
      if (record.deleted_at) return skip('record_deleted');
      if (input.lookup !== undefined) {
        const field = mapping.lookup
          ? object.state.fields.find((f) => f.universalId === mapping.lookup?.fieldId)
          : undefined;
        if (!field || field.status !== 'active')
          throw new AppError(409, 'schema_binding_conflict', 'the lookup field is unavailable');
        if (currentLookup(field, record.data[field.key]) !== input.lookup)
          return skip('lookup_changed');
      }
      const fields: MappedWriteResult['fields'] = {};
      const values: Record<string, unknown> = {};
      const outputOf = new Map<string, string>();
      for (const [key, field] of targets) {
        const value = input.values[key];
        if (Object.hasOwn(record.data, field.key)) {
          fields[key] = record.data[field.key] === null ? 'cleared' : 'populated';
          continue;
        }
        if (value === null)
          throw new AppError(422, 'validation_failed', 'mapped values cannot be null', {
            output: key,
          });
        values[field.name] = value;
        outputOf.set(field.name, key);
      }
      if (!outputOf.size) return { outcome: 'skipped', reason: 'nothing_to_fill', fields };
      const writes = prepareValues(object as CompiledObject, values, 'update');
      const statuses = await writeFields(tx, context, object, record, writes, {
        confidence: 1,
        ...(input.observedAt ? { observedAt: new Date(input.observedAt) } : {}),
      });
      for (const [name, status] of Object.entries(statuses)) {
        const key = outputOf.get(name);
        if (key)
          fields[key] =
            status === 'superseded'
              ? 'populated'
              : status === 'pending_review'
                ? status
                : 'applied';
      }
      return { outcome: 'applied', fields };
    });
  } catch (error) {
    // The run fails on a broken binding, and the admin sees it on the installation.
    if (error instanceof AppError && error.code === 'schema_binding_conflict')
      await inWorkspace(sql, caller.workspaceId, async (tx) => {
        await tx`update extension_installations set connection_health = 'degraded',
            last_error = 'schema_binding_conflict', updated_at = now()
          where id = ${run.installationId} and generation = ${run.generation}`;
      });
    throw error;
  }
}
