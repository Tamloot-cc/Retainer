import {
  bindingChoicesSchema,
  type ExtensionBindingChoices,
  type ExtensionManifest,
  type ExtensionSuggestions,
  SUGGESTION_REASON_MAX,
} from '@retainer/extension';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockSchemaShared } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { admitCaller, admitRun } from '../extension-runtime/admission.js';
import type { BindingIssue, StoredBindingPlan } from '../extension-runtime/bindings.js';
import { pendingSecrets } from '../extension-runtime/secrets.js';
import { loadSchemaState } from '../schema/load.js';
import type { SchemaState } from '../schema/types.js';
import { resolveBindingPlan } from './bindings.js';
import type { ExtensionCatalog } from './catalog.js';

export const suggestionsSchema = z.strictObject({
  bindings: bindingChoicesSchema.optional(),
  bindingReasons: z.record(z.string().max(180), z.string().max(SUGGESTION_REASON_MAX)).optional(),
  settings: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()]))
    .optional(),
});

/** The binding problems a plan resolution reports, or null when it resolves. */
function bindingIssues(resolve: () => unknown): BindingIssue[] | null {
  try {
    resolve();
    return null;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'bindings_invalid') throw error;
    return (error.details as { bindings?: BindingIssue[] } | undefined)?.bindings ?? [];
  }
}

/**
 * Drops each suggested choice the server would reject, so the review opens
 * with the fixed default there rather than an error (configure spec 2.2). The
 * check is the review's own, so a bundle need not copy the server's rules. A
 * field's problem drops that field's choice; any other problem drops the
 * binding's whole choice. Problems no suggestion caused stay for the review.
 */
function fitSuggestions(
  state: SchemaState,
  manifest: ExtensionManifest,
  suggested: ExtensionBindingChoices,
  prior: StoredBindingPlan | null | undefined,
  createPeople: StoredBindingPlan['createPeople'],
) {
  const bindings = structuredClone(suggested);
  for (;;) {
    const issues = bindingIssues(() =>
      resolveBindingPlan(state, manifest, structuredClone(bindings), prior, createPeople),
    );
    let dropped = false;
    for (const issue of issues ?? []) {
      for (const key of issue.binding === '*' ? Object.keys(bindings) : [issue.binding]) {
        const choice = bindings[key];
        if (!choice) continue;
        if (issue.field && choice.action !== 'skip' && choice.fields?.[issue.field])
          delete choice.fields[issue.field];
        else delete bindings[key];
        dropped = true;
      }
    }
    if (!dropped) return bindings;
  }
}

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
    if (job?.trigger_kind !== 'configure')
      throw new AppError(403, 'forbidden', 'only configure runs save suggestions');
    const release = catalog.forRun(run);
    for (const key of Object.keys(input.bindings ?? {}))
      if (!release.manifest.bindings?.some((binding) => binding.key === key))
        throw new AppError(400, 'invalid_suggestions', 'Unknown binding.', { key });
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
    let bindings = input.bindings;
    let reasons = input.bindingReasons;
    if (bindings) {
      const [stored] = await tx<{ bindings: StoredBindingPlan | null }[]>`
        select bindings from extension_installations where id=${run.installationId}`;
      bindings = fitSuggestions(
        await loadSchemaState(tx, caller.workspaceId),
        release.manifest,
        bindings,
        stored?.bindings,
        stored?.bindings?.createPeople ?? release.manifest.createPeople,
      );
      const kept = bindings;
      // A reason goes with its choice: `binding` or `binding.field`.
      reasons = Object.fromEntries(
        Object.entries(reasons ?? {}).filter(([key]) => {
          const [binding = '', field] = key.split('.');
          const choice = kept[binding];
          return field === undefined
            ? !!choice
            : !!choice && choice.action !== 'skip' && !!choice.fields?.[field];
        }),
      );
    }
    const [saved] =
      await tx`update extension_suggestions set bindings=${tx.json(jsonValue(bindings ?? null))},
      binding_reasons=${tx.json(jsonValue(reasons ?? null))},
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
  if (
    (caller.run || caller.installation) &&
    (caller.run?.installationId ?? caller.installation?.installationId) !== id
  )
    throw notFound('extension installation');
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    await admitCaller(tx, caller, false, 'runtime');
    const [installation] =
      await tx`select registration_id,version from extension_installations where id=${id}`;
    if (!installation) throw notFound('extension installation');
    const release = catalog.get(
      String(installation.registration_id),
      version ?? String(installation.version),
    );
    const [approval] = await tx<
      {
        secret_refs: Record<string, string>;
        settings: NonNullable<ExtensionSuggestions['access']>['settings'];
      }[]
    >`
      select a.secret_refs,a.settings from extension_access_approvals a
      join extension_installations i on i.id=a.installation_id and i.workspace_id=a.workspace_id
      where a.installation_id=${id} and a.release_digest=${release.digest}
      and a.generation=i.generation and a.settings_revision=i.settings_revision`;
    const refs = Object.values(approval?.secret_refs ?? {});
    const access =
      approval && (await pendingSecrets(tx, refs)).length === refs.length
        ? { settings: approval.settings, secrets: Object.keys(approval.secret_refs) }
        : undefined;
    const [row] = await tx<
      {
        settings: ExtensionSuggestions['settings'];
        bindings: ExtensionSuggestions['bindings'];
        binding_reasons: ExtensionSuggestions['bindingReasons'];
        status: string;
        code: string | null;
      }[]
    >`
      select s.settings,s.bindings,s.binding_reasons,j.status,j.code from extension_suggestions s join extension_jobs j on j.id=s.job_id
      join extension_installations i on i.id=s.installation_id and i.generation=j.generation
      where s.installation_id=${id} and s.release_digest=${release.digest}`;
    if (!row)
      return {
        status: 'failed',
        code: 'suggestions_unavailable',
        issues: {},
        ...(access ? { access } : {}),
      };
    const status =
      row.status === 'succeeded'
        ? 'ready'
        : row.status === 'queued' || row.status === 'running'
          ? row.status
          : 'failed';
    const issues: Record<string, string> = {};
    if (status === 'ready' && row.bindings) {
      const current = await loadSchemaState(tx, caller.workspaceId);
      const [stored] = await tx<{ bindings: StoredBindingPlan | null }[]>`
        select bindings from extension_installations where id=${id}`;
      try {
        resolveBindingPlan(
          current,
          release.manifest,
          row.bindings,
          stored?.bindings,
          stored?.bindings?.createPeople ?? release.manifest.createPeople,
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const bindings = (
          error.details as
            | {
                bindings?: { binding: string; field?: string; message: string }[];
              }
            | undefined
        )?.bindings;
        for (const issue of bindings ?? [])
          issues[[issue.binding, issue.field].filter(Boolean).join('.')] = issue.message;
      }
    }
    return {
      status,
      ...(access ? { access } : {}),
      ...(row.code ? { code: row.code } : {}),
      issues,
      ...(status === 'ready' && row.bindings
        ? { bindings: row.bindings, bindingReasons: row.binding_reasons ?? undefined }
        : {}),
      ...(status === 'ready' && row.settings ? { settings: row.settings } : {}),
    };
  });
}
