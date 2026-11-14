import type Anthropic from '@anthropic-ai/sdk';
import {
  type ExecutionResult,
  type ExtensionMapping,
  type ExtensionMappingChoice,
  type ExtensionMappingView,
  type Invocation,
  isRetryLater,
} from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { normalizeDomain, type ObjectView } from '@retainer/shared';
import { z } from 'zod';
import { ENRICHMENT, enrichmentManifest } from './enrichment-contract.js';
import {
  enrichmentModel,
  type ModelFailure,
  ModelRequestFailed,
  pickCandidate,
  type SuggestField,
  suggestMapping,
} from './enrichment-model.js';
import {
  acceptPick,
  type Candidate,
  type Certainty,
  candidateValues,
  type EnrichmentValues,
  ExaError,
  ExaProvider,
  shortcut,
} from './enrichment-provider.js';
import { apiFetch, transient } from './outcome.js';

export { ENRICHMENT_FUNCTION_IDS, enrichmentManifest } from './enrichment-contract.js';

const changeInput = z.strictObject({ changePosition: z.string().max(19) });
const configureInput = z.object({ reason: z.string().optional() }).passthrough();
const done = (code: string): ExecutionResult => ({ status: 'succeeded', code });

/** The primary URL of a links value, if it has one. */
function primaryUrl(value: unknown): string | null {
  const url = (value as { primary?: { url?: unknown } | null } | null)?.primary?.url;
  return typeof url === 'string' ? url : null;
}

/** Confidence of a `medium` pick; the workspace's review threshold may hold it (spec 6.4). */
export const MEDIUM_CONFIDENCE = 0.7;
/** A stored pick older than this is ignored and overwritten (spec 6.5). */
export const PICK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KV_KEY_MAX = 200;
const storedPick = z.object({
  candidateUrl: z.string(),
  certainty: z.enum(['high', 'medium', 'low']),
  at: z.iso.datetime({ offset: true }),
});

export type Found =
  | { status: 'match'; values: EnrichmentValues; confidence: number; code: string }
  | { status: 'no_match'; code: string };
const noMatch = (failure?: ModelFailure): Found => ({
  status: 'no_match',
  code: failure ? `no_match_model_${failure}` : 'no_match_model',
});

type Lookup = {
  sdk: RetainerClient;
  installationId: string;
  exa: ExaProvider;
  model: () => Anthropic | null;
  signal: AbortSignal;
};

/**
 * The lookup (model calls spec 6.3): search by name and domain, accept the one
 * candidate on the domain without a model call, or else let the model pick
 * one and check the pick. A pick is kept in installation KV so a retry after
 * it doesn't call the model again.
 */
export async function lookUp(
  run: Lookup,
  record: { id: string; name: string | null; domain: string; context: Record<string, unknown> },
): Promise<Found> {
  const candidates = await run.exa.search(record.domain, record.name);
  if (!candidates.length) return { status: 'no_match', code: 'no_match' };
  const direct = shortcut(record.domain, candidates);
  if (direct)
    return {
      status: 'match',
      values: candidateValues(direct),
      confidence: 1,
      code: 'matched_shortcut',
    };
  const key = `pick:${record.id}:${record.domain}`;
  const keep = key.length <= KV_KEY_MAX;
  const stored = keep ? await run.sdk.extensionKv(run.installationId, key) : null;
  const previous = storedPick.safeParse(stored?.value);
  let pick: { candidate: Candidate; certainty: Certainty } | undefined;
  if (previous.success && Date.now() - Date.parse(previous.data.at) < PICK_TTL_MS) {
    const candidate = candidates.find((c) => c.url === previous.data.candidateUrl);
    if (candidate) pick = { candidate, certainty: previous.data.certainty };
  }
  if (!pick) {
    const answer = await pickCandidate(run.model(), record, candidates, run.signal);
    if (answer.status !== 'ok') return noMatch(answer.status);
    if (answer.value.index === null) return noMatch();
    const candidate = candidates.find((c) => c.index === answer.value.index);
    if (!candidate) return noMatch('output');
    pick = { candidate, certainty: answer.value.certainty };
    if (keep)
      await run.sdk
        .extensionCheckpoint(run.installationId, {
          children: [],
          kv: {
            key,
            expectedRevision: stored?.revision ?? null,
            value: {
              candidateUrl: candidate.url,
              certainty: pick.certainty,
              at: new Date().toISOString(),
            },
          },
        })
        .catch((error) => {
          // A concurrent run stored its own pick; this one still stands.
          if (!(error instanceof RetainerApiError && error.status === 409)) throw error;
        });
  }
  if (!acceptPick(pick, record)) return noMatch();
  return {
    status: 'match',
    values: candidateValues(pick.candidate),
    confidence: pick.certainty === 'high' ? 1 : MEDIUM_CONFIDENCE,
    code: `matched_model_${pick.certainty}`,
  };
}

/** The record's values of the other bound outputs, for the model to compare against. */
function mappedContext(
  mapping: ExtensionMappingView,
  record: { fields: Record<string, unknown> },
): Record<string, unknown> {
  return Object.fromEntries(
    mapping.outputs.flatMap((output) =>
      output.action !== 'skip' && output.field && Object.hasOwn(record.fields, output.field.name)
        ? [[output.output, record.fields[output.field.name]]]
        : [],
    ),
  );
}

type MappingOutput = ExtensionMapping['outputs'][number];
/** Each company may need a search and a model call, so pages stay small. */
const BACKFILL_PAGE = 10;
const SAMPLE_COMPANIES = 20;
const SAMPLES_PER_FIELD = 5;
const SAMPLE_MAX_CHARACTERS = 500;
const REASON_MAX = 500;

/** Writable Company fields of a type the output accepts, other than the lookup field. */
function compatibleFields(company: ObjectView | undefined, output: MappingOutput) {
  return (company?.fields ?? []).filter(
    (f) =>
      !f.readOnly &&
      (output.types as readonly string[]).includes(f.type) &&
      f.baseField !== 'companyDomain',
  );
}

type Choices = Record<string, ExtensionMappingChoice & { reason?: string }>;
/** Today's suggestions without a model: the expected API name and a compatible type. */
function byNameAndType(company: ObjectView | undefined, outputs: MappingOutput[]): Choices {
  return Object.fromEntries(
    outputs.map((output) => {
      const field = compatibleFields(company, output).find((f) => f.name === output.field?.name);
      return [
        output.key,
        field
          ? {
              action: 'existing' as const,
              field: field.name,
              reason: 'This field has the expected API name and a compatible type.',
            }
          : output.field
            ? {
                action: 'create' as const,
                reason: 'Create the suggested field; no matching compatible API name exists.',
              }
            : { action: 'skip' as const, reason: 'No compatible destination was identified.' },
      ];
    }),
  );
}

/**
 * Suggestions from the model (model calls spec 6.1): a sample of recently
 * updated companies, the compatible fields with up to five values each, and
 * the current mapping on an upgrade or a request. A choice the schema can't
 * take keeps the name-and-type suggestion for that output. Null when the
 * model gave no usable answer.
 */
async function suggestWithModel(
  sdk: RetainerClient,
  model: Anthropic | null,
  company: ObjectView | undefined,
  outputs: MappingOutput[],
  current: ExtensionMappingView | null,
  fallback: Choices,
  signal: AbortSignal,
): Promise<Choices | null> {
  if (!model) return null;
  const candidates = new Map(
    outputs.flatMap((output) => compatibleFields(company, output)).map((f) => [f.name, f]),
  );
  const samples = new Map<string, unknown[]>();
  if (company && candidates.size) {
    const page = await sdk.queryRecords(company.nameSingular, {
      limit: SAMPLE_COMPANIES,
      sort: [{ field: 'updatedAt', direction: 'desc' }],
    });
    for (const record of page.records)
      for (const name of candidates.keys()) {
        const value = record.fields[name];
        const list = samples.get(name) ?? [];
        if (
          list.length < SAMPLES_PER_FIELD &&
          value !== null &&
          value !== undefined &&
          value !== '' &&
          JSON.stringify(value).length <= SAMPLE_MAX_CHARACTERS
        )
          samples.set(name, [...list, value]);
      }
  }
  const fields: SuggestField[] = [...candidates.values()].map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    description: f.description,
    samples: samples.get(f.name) ?? [],
  }));
  const answer = await suggestMapping(
    model,
    {
      outputs: outputs.map((output) => ({
        key: output.key,
        label: output.label,
        description: output.description,
        types: [...output.types],
        suggestedField: output.field
          ? { name: output.field.name, label: output.field.label, type: output.field.type }
          : null,
      })),
      fields,
      current: current
        ? Object.fromEntries(
            current.outputs.map((b) => [
              b.output,
              { action: b.action, ...(b.field ? { field: b.field.name } : {}) },
            ]),
          )
        : null,
    },
    signal,
  );
  if (answer.status !== 'ok') return null;
  return Object.fromEntries(
    outputs.map((output) => {
      const choice = answer.value[output.key];
      const reason = choice?.reason.trim().slice(0, REASON_MAX) || undefined;
      const fits =
        choice?.action === 'existing'
          ? compatibleFields(company, output).some((f) => f.name === choice.field)
          : choice?.action === 'create'
            ? Boolean(output.field)
            : choice?.action === 'skip';
      if (!choice || !fits)
        return [output.key, fallback[output.key] ?? { action: 'skip' as const }];
      return [
        output.key,
        choice.action === 'existing'
          ? { action: 'existing' as const, field: choice.field as string, reason }
          : { action: choice.action, reason },
      ];
    }),
  );
}

/**
 * Company enrichment (enrichment spec 4.4, 4.5; model calls spec 6). Setup
 * checks the Exa key. Configure suggests the mapping with the model, or by
 * name and type without one. A change run reads the current company and the
 * approved mapping, looks it up (`lookUp`), and sends only valid values for
 * mapped outputs to the fill-only mapped write, which decides what is
 * written. Diagnostics carry codes only: never a domain, a key, a provider
 * body or a model's answer.
 */
export async function executeEnrichment(
  invocation: Invocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  const sdk = new RetainerClient({
    baseUrl: invocation.apiOrigin,
    apiKey: invocation.runToken,
    fetch: apiFetch(transport, signal),
  });
  const id = invocation.installationId;
  let client: Anthropic | null | undefined;
  const model = () => {
    client ??= enrichmentModel(invocation, transport);
    return client;
  };
  const exa = async () =>
    new ExaProvider((await sdk.extensionSecret(id, 'apiKey')).value, signal, transport);
  try {
    if (invocation.functionId === ENRICHMENT.configure) {
      await (await exa()).check();
      const schema = await sdk.schema();
      const company = schema.objects.find((o) => o.baseObject === 'company');
      const contract = enrichmentManifest({
        packageDigest: 'a'.repeat(64),
        handlerDigest: 'b'.repeat(64),
        serverRange: '>=0.1.0 <0.2.0',
      });
      const outputs = contract.mapping?.outputs ?? [];
      const fallback = byNameAndType(company, outputs);
      const reason = configureInput.safeParse(invocation.input).data?.reason;
      let suggested: Choices | null = null;
      try {
        const current = reason === 'install' ? null : ((await sdk.extension(id)).mapping ?? null);
        suggested = await suggestWithModel(
          sdk,
          model(),
          company,
          outputs,
          current,
          fallback,
          signal,
        );
      } catch {
        // Any failure falls back to name-and-type suggestions (spec 6.1).
        if (signal.aborted) throw new Error('aborted');
      }
      await sdk.saveExtensionSuggestions(id, { mapping: suggested ?? fallback });
      return done(suggested ? 'suggestions_ready' : 'suggestions_ready_without_model');
    }
    if (invocation.functionId === ENRICHMENT.backfill) {
      const input = z
        .strictObject({ cursor: z.string().max(4096).optional() })
        .parse(invocation.input);
      const schema = await sdk.schema();
      const company = schema.objects.find((o) => o.baseObject === 'company');
      if (!company) return done('not_applicable');
      const page = await sdk.queryRecords(company.nameSingular, {
        limit: BACKFILL_PAGE,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const mapping = (await sdk.extension(id)).mapping;
      if (mapping?.lookup?.status !== 'ok')
        return { status: 'failed', code: 'schema_binding_conflict' };
      const run: Lookup = { sdk, installationId: id, exa: await exa(), model, signal };
      for (const row of page.records) {
        let record: Awaited<ReturnType<typeof sdk.record>>;
        try {
          record = await sdk.record(row.id);
        } catch (error) {
          if (error instanceof RetainerApiError && [404, 410].includes(error.status)) continue;
          throw error;
        }
        if (record.id !== row.id) continue;
        if (!Object.values(record.provenance ?? {}).some((p) => p.assertion?.actor.id === id))
          continue;
        const domain = normalizeDomain(primaryUrl(record.fields[mapping.lookup.name]) ?? '');
        const open = mapping.outputs.filter(
          (o) => o.status === 'ok' && o.field && !Object.hasOwn(record.fields, o.field.name),
        );
        if (!domain || !open.length) continue;
        const found = await lookUp(run, {
          id: record.id,
          name: record.label,
          domain,
          context: mappedContext(mapping, record),
        });
        if (found.status !== 'match') continue;
        const wanted = new Set(open.map((o) => o.output));
        const values = Object.fromEntries(
          Object.entries(found.values).filter(([key]) => wanted.has(key)),
        );
        if (Object.keys(values).length)
          await sdk.extensionMappedWrite(id, {
            recordId: row.id,
            lookup: domain,
            values,
            ...(found.confidence < 1 ? { confidence: found.confidence } : {}),
          });
      }
      if (page.nextCursor)
        await sdk.extensionCheckpoint(id, {
          children: [
            {
              functionId: ENRICHMENT.backfill,
              input: { cursor: page.nextCursor },
              dedupeKey: `backfill:${invocation.runId}`,
            },
          ],
        });
      return done('backfill_page');
    }
    if (invocation.functionId === ENRICHMENT.setup) {
      await (await exa()).check();
      const input = invocation.input as { previousVersion?: string | null };
      const mapping = (await sdk.extension(id)).mapping;
      const previous = await sdk.extensionKv(id, 'mappedOutputs');
      const keys = mapping?.outputs.filter((o) => o.action !== 'skip').map((o) => o.output) ?? [];
      if (
        input.previousVersion &&
        keys.some((key) => !(Array.isArray(previous?.value) && previous.value.includes(key)))
      )
        await sdk.extensionCheckpoint(id, {
          children: [
            {
              functionId: ENRICHMENT.backfill,
              input: {},
              dedupeKey: `backfill:${invocation.runId}`,
            },
          ],
        });
      await sdk.extensionCheckpoint(id, {
        children: [],
        kv: { key: 'mappedOutputs', expectedRevision: previous?.revision ?? null, value: keys },
      });
      return { status: 'succeeded' };
    }
    if (invocation.functionId !== ENRICHMENT.enrich)
      return { status: 'failed', code: 'function_not_bundled' };
    const input = changeInput.safeParse(invocation.input);
    if (!input.success) return { status: 'failed', code: 'invalid_input' };
    const change = await sdk.change(input.data.changePosition);
    if (!change.recordId || !['create', 'update'].includes(change.operation))
      return done('not_applicable');
    const mapping = (await sdk.extension(id)).mapping;
    if (!mapping) return { status: 'failed', code: 'mapping_required' };
    const bound = mapping.outputs.filter((output) => output.action !== 'skip');
    if (
      mapping.lookup?.status !== 'ok' ||
      bound.some((output) => output.status !== 'ok' || !output.field)
    )
      return { status: 'failed', code: 'schema_binding_conflict' };
    let record: Awaited<ReturnType<typeof sdk.record>>;
    try {
      record = await sdk.record(change.recordId);
    } catch (error) {
      if (error instanceof RetainerApiError && (error.status === 404 || error.status === 410))
        return done('record_gone');
      throw error;
    }
    // A merged-away ID reads as its survivor, which has its own changes.
    if (record.id !== change.recordId) return done('record_gone');
    const domain = normalizeDomain(primaryUrl(record.fields[mapping.lookup.name]) ?? '');
    if (!domain) return done('no_domain');
    // Advisory: the mapped write decides under the record lock.
    const open = bound.filter(
      (output) => output.field && !Object.hasOwn(record.fields, output.field.name),
    );
    if (!open.length) return done('nothing_to_fill');
    const found = await lookUp(
      { sdk, installationId: id, exa: await exa(), model, signal },
      { id: record.id, name: record.label, domain, context: mappedContext(mapping, record) },
    );
    if (found.status === 'no_match') return done(found.code);
    const wanted = new Set(open.map((output) => output.output));
    const values = Object.fromEntries(
      Object.entries(found.values).filter(([output]) => wanted.has(output)),
    );
    if (!Object.keys(values).length) return done('no_usable_values');
    const written = await sdk.extensionMappedWrite(id, {
      recordId: change.recordId,
      lookup: domain,
      values,
      ...(found.confidence < 1 ? { confidence: found.confidence } : {}),
    });
    return done(written.outcome === 'applied' ? found.code : (written.reason ?? 'skipped'));
  } catch (error) {
    if (error instanceof ExaError)
      return {
        status: error.retry ? 'retry' : 'failed',
        code: error.code === 'provider_not_found' ? 'provider_invalid_request' : error.code,
        ...(error.retry ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    if (error instanceof ModelRequestFailed) return { status: 'failed', code: error.message };
    if (error instanceof RetainerApiError && error.code === 'schema_binding_conflict')
      return { status: 'failed', code: 'schema_binding_conflict' };
    const retryable = transient(error);
    if (isRetryLater(retryable)) throw retryable;
    return { status: 'failed', code: 'handler_failed' };
  }
}
