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
import { BASE_FIELD_IDS, normalizeDomain, type ObjectView } from '@retainer/shared';
import { z } from 'zod';
import { ENRICHMENT, ENRICHMENT_MAPPING } from './enrichment-contract.js';
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

type Found =
  | {
      status: 'match';
      values: EnrichmentValues;
      confidence: number;
      code: string;
    }
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
 * one and check the pick. Nothing is kept between attempts: a retry after the
 * model call calls it again (spec 6.5).
 */
export async function lookUp(
  run: Lookup,
  record: { name: string | null; domain: string; context: Record<string, unknown> },
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
  const answer = await pickCandidate(run.model(), record, candidates, run.signal);
  if (answer.status !== 'ok') return noMatch(answer.status);
  if (answer.value.index === null) return noMatch();
  const candidate = candidates.find((c) => c.index === answer.value.index);
  if (!candidate) return noMatch('output');
  const pick = { candidate, certainty: answer.value.certainty };
  if (!acceptPick(pick, record)) return noMatch();
  return {
    status: 'match',
    values: candidateValues(candidate),
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
/** The lookup field's base name (`companyDomain`), never a destination. */
const LOOKUP_BASE_FIELD = Object.entries(BASE_FIELD_IDS).find(
  ([, id]) => id === ENRICHMENT_MAPPING.lookup.fieldId,
)?.[0];
/** Each company may need a search and a model call, so pages stay small. */
const BACKFILL_PAGE = 10;
/** Companies of a backfill page looked up at once, to stay well inside its 300 s. */
const BACKFILL_CONCURRENCY = 3;
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
      f.baseField !== LOOKUP_BASE_FIELD,
  );
}

type Choice = ExtensionMappingChoice & { reason?: string };
type Choices = Record<string, Choice>;
/** Today's suggestion without a model: the expected API name and a compatible type. */
function byNameAndType(company: ObjectView | undefined, output: MappingOutput): Choice {
  const field = compatibleFields(company, output).find((f) => f.name === output.field?.name);
  if (field)
    return {
      action: 'existing',
      field: field.name,
      reason: 'This field has the expected API name and a compatible type.',
    };
  if (output.field)
    return {
      action: 'create',
      reason: 'Create the suggested field; no matching compatible API name exists.',
    };
  return { action: 'skip', reason: 'No compatible destination was identified.' };
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
          samples.set(name, list.concat([value]));
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
      const field = choice?.field;
      if (
        choice?.action === 'existing' &&
        field &&
        compatibleFields(company, output).some((f) => f.name === field)
      )
        return [output.key, { action: 'existing' as const, field, reason }];
      if (choice?.action === 'skip' || (choice?.action === 'create' && output.field))
        return [output.key, { action: choice.action, reason }];
      return [output.key, byNameAndType(company, output)];
    }),
  );
}

/**
 * The company's name, for the search and the name guard: its label, but only
 * when Company's label field is a text field. A workspace may make an email,
 * phone, link or number the label, and that is not a name to send to Exa.
 */
function companyName(company: ObjectView | undefined, record: { label: string | null }) {
  const label = company?.fields.find((f) => f.name === company.labelField);
  return label?.type === 'text' ? record.label : null;
}

/**
 * Looks a company up and sends the values of its open outputs to the
 * fill-only mapped write, which decides what is written. Returns the run code:
 * how it matched when something was written, otherwise why not.
 */
async function fill(
  run: Lookup,
  mapping: ExtensionMappingView,
  record: { id: string; name: string | null; fields: Record<string, unknown> },
  domain: string,
  open: ExtensionMappingView['outputs'],
): Promise<string> {
  const found = await lookUp(run, {
    name: record.name,
    domain,
    context: mappedContext(mapping, record),
  });
  if (found.status === 'no_match') return found.code;
  const wanted = new Set(open.map((output) => output.output));
  const values = Object.fromEntries(
    Object.entries(found.values).filter(([output]) => wanted.has(output)),
  );
  if (!Object.keys(values).length) return 'no_usable_values';
  const written = await run.sdk.extensionMappedWrite(run.installationId, {
    recordId: record.id,
    lookup: domain,
    values,
    ...(found.confidence < 1 ? { confidence: found.confidence } : {}),
  });
  return written.outcome === 'applied' ? found.code : (written.reason ?? 'skipped');
}

/**
 * Runs `work` on each item, at most `limit` at a time. After a failure no
 * more items start; the first error is thrown once the running ones settle.
 */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined && !failed; item = queue.shift())
        await work(item).catch((error) => {
          failed = true;
          throw error;
        });
    }),
  );
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
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
      const outputs = ENRICHMENT_MAPPING.outputs;
      const reason = configureInput.safeParse(invocation.input).data?.reason;
      let suggested: Choices | null = null;
      try {
        const current = reason === 'install' ? null : ((await sdk.extension(id)).mapping ?? null);
        suggested = await suggestWithModel(sdk, model(), company, outputs, current, signal);
      } catch {
        // Any failure falls back to name-and-type suggestions (spec 6.1).
        if (signal.aborted) throw new Error('aborted');
      }
      const mapping =
        suggested ??
        Object.fromEntries(outputs.map((output) => [output.key, byNameAndType(company, output)]));
      await sdk.saveExtensionSuggestions(id, { mapping });
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
      const lookupField = mapping.lookup.name;
      const run: Lookup = { sdk, installationId: id, exa: await exa(), model, signal };
      await eachLimited(page.records, BACKFILL_CONCURRENCY, async (row) => {
        let record: Awaited<ReturnType<typeof sdk.record>>;
        try {
          record = await sdk.record(row.id);
        } catch (error) {
          if (error instanceof RetainerApiError && [404, 410].includes(error.status)) return;
          throw error;
        }
        if (record.id !== row.id) return;
        // A value held for review counts: its company was enriched before.
        if (
          !Object.values(record.provenance ?? {}).some(
            (p) => p.assertion?.actor.id === id || p.pendingAssertion?.actor.id === id,
          )
        )
          return;
        const domain = normalizeDomain(primaryUrl(record.fields[lookupField]) ?? '');
        const open = mapping.outputs.filter(
          (o) => o.status === 'ok' && o.field && !Object.hasOwn(record.fields, o.field.name),
        );
        if (domain && open.length)
          await fill(run, mapping, { ...record, name: companyName(company, record) }, domain, open);
      });
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
    const company = (await sdk.schema()).objects.find((o) => o.baseObject === 'company');
    return done(
      await fill(
        { sdk, installationId: id, exa: await exa(), model, signal },
        mapping,
        { ...record, name: companyName(company, record) },
        domain,
        open,
      ),
    );
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
