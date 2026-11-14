import {
  type ExtensionSuggestions,
  mappingChoiceSchema,
  outputKeySchema,
} from '@retainer/extension';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockSchemaShared } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { admitRun } from '../extension-runtime/admission.js';
import type { ContributionRow } from '../extension-runtime/retired.js';
import { loadSchemaState } from '../schema/load.js';
import type { ExtensionCatalog } from './catalog.js';
import { resolveMapping, type StoredMapping } from './mapping.js';

export const suggestionsSchema = z.strictObject({
  mapping: z
    .record(
      outputKeySchema,
      z.union([
        mappingChoiceSchema.options[0].extend({ reason: z.string().max(500).optional() }),
        mappingChoiceSchema.options[1].extend({ reason: z.string().max(500).optional() }),
        mappingChoiceSchema.options[2].extend({ reason: z.string().max(500).optional() }),
      ]),
    )
    .optional(),
  settings: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()]))
    .optional(),
});

export async function saveSuggestions(
  sql: Sql,
  catalog: ExtensionCatalog,
  caller: Caller,
  input: z.infer<typeof suggestionsSchema>,
) {
  const run = caller.run;
  if (!run) throw new AppError(403, 'forbidden', 'configure run required');
  if (Buffer.byteLength(JSON.stringify(input)) > 65536)
    throw new AppError(400, 'invalid_suggestions', 'suggestions exceed 64 KiB');
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    await admitRun(tx, caller.workspaceId, run, false, 'runtime');
    const [job] = await tx`select trigger_kind from extension_jobs where id=${run.jobId}`;
    const release = catalog
      .list()
      .find((r) => r.digest === run.releaseDigest && r.manifest.universalId === run.registrationId);
    if (job?.trigger_kind !== 'configure' || !release)
      throw new AppError(403, 'forbidden', 'only configure runs save suggestions');
    for (const key of Object.keys(input.mapping ?? {}))
      if (!release.manifest.mapping?.outputs.some((o) => o.key === key))
        throw new AppError(400, 'invalid_suggestions', 'unknown output', { key });
    for (const [key, value] of Object.entries(input.settings ?? {})) {
      const definition = release.manifest.settings[key];
      if (
        !definition ||
        definition.secret ||
        definition.level === 'connection' ||
        typeof value !== definition.type ||
        (definition.options && !definition.options.includes(String(value))) ||
        (definition.consent && value !== true)
      )
        throw new AppError(
          400,
          'invalid_suggestions',
          'unknown, secret or incorrectly typed setting',
          { key },
        );
    }
    const [saved] =
      await tx`update extension_suggestions set mapping=${tx.json(jsonValue(input.mapping ?? null))},
      settings=${tx.json(jsonValue(input.settings ?? null))}
      where installation_id=${run.installationId} and release_digest=${run.releaseDigest} and job_id=${run.jobId} returning job_id`;
    if (!saved)
      throw new AppError(
        409,
        'stale_suggestions',
        'a newer configure run replaced these suggestions',
      );
    return { saved: true };
  });
}

export async function getSuggestions(
  sql: Sql,
  catalog: ExtensionCatalog,
  caller: Caller,
  id: string,
  version?: string,
): Promise<ExtensionSuggestions> {
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    const [installation] =
      await tx`select registration_id,version from extension_installations where id=${id}`;
    if (!installation) throw notFound('extension installation');
    const release = catalog.get(
      String(installation.registration_id),
      version ?? String(installation.version),
    );
    const [row] = await tx<
      {
        mapping: ExtensionSuggestions['mapping'];
        settings: ExtensionSuggestions['settings'];
        status: string;
        code: string | null;
      }[]
    >`
      select s.mapping,s.settings,j.status,j.code from extension_suggestions s join extension_jobs j on j.id=s.job_id
      join extension_installations i on i.id=s.installation_id and i.generation=j.generation
      where s.installation_id=${id} and s.release_digest=${release.digest}`;
    if (!row) return { status: 'failed', code: 'suggestions_unavailable', issues: {} };
    const status =
      row.status === 'succeeded'
        ? 'ready'
        : row.status === 'queued' || row.status === 'running'
          ? row.status
          : 'failed';
    const issues: Record<string, string> = {};
    // Partial suggestions are allowed; missing outputs fall back to the form defaults.
    if (status === 'ready' && row.mapping) {
      const current = await loadSchemaState(tx, caller.workspaceId);
      const [stored] = await tx<
        { mapping: StoredMapping }[]
      >`select mapping from extension_installations where id=${id}`;
      const owned = await tx<ContributionRow[]>`
        select kind,universal_id,element_id,definition from extension_contributions where installation_id=${id}`;
      const choices = Object.fromEntries(
        release.manifest.mapping?.outputs.map((o) => {
          const suggestion = row.mapping?.[o.key];
          return [
            o.key,
            suggestion
              ? mappingChoiceSchema.parse(
                  Object.fromEntries(Object.entries(suggestion).filter(([k]) => k !== 'reason')),
                )
              : { action: 'skip' as const },
          ];
        }) ?? [],
      );
      try {
        resolveMapping(current, release.manifest, choices, stored?.mapping, owned);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const outputs = (
          error.details as { outputs?: { output: string; reason: string }[] } | undefined
        )?.outputs;
        if (outputs) for (const issue of outputs) issues[issue.output] = issue.reason;
        else issues['*'] = error.code;
      }
    }
    return {
      status,
      ...(row.code ? { code: row.code } : {}),
      issues,
      ...(status === 'ready' && row.mapping ? { mapping: row.mapping } : {}),
      ...(status === 'ready' && row.settings ? { settings: row.settings } : {}),
    };
  });
}
