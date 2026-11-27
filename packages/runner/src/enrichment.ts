import type Anthropic from '@anthropic-ai/sdk';
import {
  bindableField,
  type ExecutionResult,
  type ExtensionBindingChoices,
  type ExtensionBindingPlan,
  type Invocation,
  isRetryLater,
} from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import {
  isRecordId,
  normalizeDomain,
  normalizeEmail,
  type ObjectView,
  type PresentedRecord,
} from '@retainer/shared';
import { z } from 'zod';
import { suggestBindings } from './binding-suggestions.js';
import {
  COMPANY_OUTPUTS,
  ENRICHMENT,
  ENRICHMENT_BINDINGS,
  ENRICHMENT_MODEL,
  type EnrichmentBindingKey,
  OUTPUTS_BY_BINDING,
} from './enrichment-contract.js';
import {
  CONFIGURE_SYSTEM,
  type Found,
  MEDIUM_CONFIDENCE,
  pickCandidate,
  resolvePick,
} from './enrichment-model.js';
import { lookUpPerson, type PersonRecord } from './enrichment-person.js';
import {
  acceptPick,
  candidateValues,
  ExaError,
  ExaProvider,
  normalizeCompanyName,
  shortcut,
} from './enrichment-provider.js';
import { ModelRequestFailed, runModel } from './model-call.js';
import { apiFetch, eachLimited, transient } from './outcome.js';

export { ENRICHMENT_FUNCTION_IDS, enrichmentManifest } from './enrichment-contract.js';
export { MEDIUM_CONFIDENCE };

const buttonInput = z.strictObject({ recordId: z.uuid() });
const changeInput = z.strictObject({ changePosition: z.string().max(19) });
const configureInput = z.object({ reason: z.string().optional() }).passthrough();
const pageInput = z.strictObject({ cursor: z.string().max(4096).optional() });
const done = (code: string): ExecutionResult => ({ status: 'succeeded', code });

/** The primary URL of a links value, if it has one. */
function primaryUrl(value: unknown): string | null {
  const url = (value as { primary?: { url?: unknown } | null } | null)?.primary?.url;
  return typeof url === 'string' ? url : null;
}
/** The primary address of an emails value, as the mapped write compares it. */
function primaryEmail(value: unknown): string | null {
  const email = (value as { primary?: unknown } | null)?.primary;
  return typeof email === 'string' ? normalizeEmail(email) : null;
}
/** A name from a text or full-name field. */
function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  const name = value as { first?: unknown; last?: unknown } | null;
  const parts = [name?.first, name?.last].filter(
    (part): part is string => typeof part === 'string' && !!part.trim(),
  );
  return parts.length ? parts.join(' ').trim() : null;
}

/** Characters of one record value, and of all of them, sent to the model with a person lookup. */
const DETAIL_CHARS = 500;
const DETAILS_CHARS = 3000;

/**
 * A field value as text: its text, number, list, name, email, link or the
 * parts of an address. A related record is its label, from the references
 * the record was read with; one it can't see is left out, not sent as an ID.
 */
function textOf(value: unknown, references: PresentedRecord['relationReferences']): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') {
    const reference = references?.[value];
    if (reference) return reference.label?.trim() || null;
    const text = value.trim();
    return text && !isRecordId(text as unknown) ? text : null;
  }
  if (Array.isArray(value))
    return (
      value
        .map((item) => textOf(item, references))
        .filter(Boolean)
        .join(', ') || null
    );
  // A boolean or an amount of money says nothing about who someone is.
  if (!value || typeof value !== 'object' || 'amountMicros' in value) return null;
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === 'string') return primary.trim() || null;
  const text =
    primaryUrl(value) ??
    nameOf(value) ??
    Object.values(value)
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .join(', ');
  return text || null;
}

/**
 * The person's other values for the lookup (spec 7.3), by field: everything
 * but the lookup fields it sends on its own and the LinkedIn output, each cut
 * at 500 characters and 3,000 in all.
 */
function personDetails(mapping: Mapping, record: PresentedRecord): Record<string, string> {
  const own = new Set(
    [
      mapping.lookups.name,
      mapping.lookups.email,
      mapping.lookups.company,
      mapping.outputs.find(({ output }) => output === 'linkedin_url')?.field,
    ].filter(Boolean),
  );
  const details: Record<string, string> = {};
  let budget = DETAILS_CHARS;
  for (const [field, value] of Object.entries(record.fields)) {
    const text = own.has(field) ? null : textOf(value, record.relationReferences);
    if (!text || budget <= 0) continue;
    details[field] = text.slice(0, Math.min(DETAIL_CHARS, budget));
    budget -= details[field].length;
  }
  return details;
}

type Run = {
  sdk: RetainerClient;
  installationId: string;
  exa: ExaProvider;
  model: () => Anthropic | null;
  signal: AbortSignal;
};

/**
 * The company lookup (model calls spec 6.3): search by name and domain,
 * accept the one candidate on the domain without a model call, or else let
 * the model pick one and check the pick. Nothing is kept between attempts: a
 * retry after the model call calls it again (spec 6.5).
 */
export async function lookUp(
  run: Pick<Run, 'exa' | 'model' | 'signal'>,
  record: { name: string | null; domain: string | null; context: Record<string, unknown> },
): Promise<Found> {
  const candidates = await run.exa.search(record.domain, record.name);
  if (!candidates.length) return { status: 'no_match', code: 'no_match' };
  if (!record.domain) {
    const name = record.name ? normalizeCompanyName(record.name) : '';
    const matches = candidates.filter(
      (candidate) => candidate.name && normalizeCompanyName(candidate.name) === name,
    );
    if (!name || matches.length !== 1) return { status: 'no_match', code: 'no_match' };
  }
  const direct = record.domain ? shortcut(record.domain, candidates) : undefined;
  if (direct)
    return {
      status: 'match',
      values: candidateValues(direct),
      confidence: 1,
      code: 'matched_shortcut',
    };
  const answer = await pickCandidate(run.model(), record, candidates, run.signal);
  return resolvePick(answer, candidates, (pick) => acceptPick(pick, record), candidateValues);
}

/** One binding's approved destination, as a run reads it. */
type Mapping = {
  key: EnrichmentBindingKey;
  object: string;
  /** The destination is intact and every required lookup field is bound. */
  usable: boolean;
  /** Bound lookup fields by binding field key: their API names. */
  lookups: Partial<Record<string, string>>;
  /** Bound outputs and their fields' API names. */
  outputs: { output: string; field: string }[];
};

function mappingOf(plan: ExtensionBindingPlan, key: EnrichmentBindingKey): Mapping | null {
  const destination = plan.bindings[key];
  const object = destination?.objects[0];
  if (!destination || !object) return null;
  const field = (name: string) => destination.fields[name]?.name;
  const rules = ENRICHMENT_BINDINGS.find((binding) => binding.key === key)?.fields ?? [];
  const lookups: Mapping['lookups'] = {};
  for (const rule of rules) {
    const name = rule.lookup && field(rule.key);
    if (name) lookups[rule.key] = name;
  }
  return {
    key,
    object: object.name,
    usable:
      destination.status === 'ok' &&
      rules.every((rule) => !rule.lookup || !rule.required || !!lookups[rule.key]),
    lookups,
    outputs: OUTPUTS_BY_BINDING[key].flatMap((output) => {
      const name = field(output.key);
      return name ? [{ output: output.key, field: name }] : [];
    }),
  };
}

/** The record's values of the other bound outputs, for the model to compare against. */
const mappedContext = (mapping: Mapping, record: { fields: Record<string, unknown> }) =>
  Object.fromEntries(
    mapping.outputs.flatMap(({ output, field }) =>
      Object.hasOwn(record.fields, field) ? [[output, record.fields[field]]] : [],
    ),
  );

/**
 * The company's name, for the search and the name guard: its bound name, but
 * only when that is text. A workspace may make an email, phone, link or
 * number the label, and that is not a name to send to Exa.
 */
function companyName(mapping: Mapping, record: { fields: Record<string, unknown> }) {
  const value = mapping.lookups.name ? record.fields[mapping.lookups.name] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
const companyDomain = (mapping: Mapping, record: { fields: Record<string, unknown> }) =>
  mapping.lookups.domain
    ? normalizeDomain(primaryUrl(record.fields[mapping.lookups.domain]) ?? '') || null
    : null;

type Context = Run & { companies: Mapping | null };

/** The person's linked company as the company binding reads it, or null. */
async function linkedCompany(ctx: Context, mapping: Mapping, record: PresentedRecord) {
  const id = mapping.lookups.company ? record.fields[mapping.lookups.company] : undefined;
  if (typeof id !== 'string') return null;
  const company = await readRecord(ctx.sdk, id, ctx.signal, []);
  if (!company) return null;
  const label = company.label?.trim() || null;
  return ctx.companies
    ? {
        name: companyName(ctx.companies, company) ?? label,
        domain: companyDomain(ctx.companies, company),
      }
    : { name: label, domain: null };
}

/**
 * Looks one record up and sends the values of its open outputs to the
 * fill-only mapped write, which decides what is written. Returns the run
 * code: how it matched when something was written, otherwise why not.
 */
async function enrichRecord(
  ctx: Context,
  mapping: Mapping,
  record: PresentedRecord,
  manual = false,
) {
  const open = mapping.outputs.filter(({ field }) => !Object.hasOwn(record.fields, field));
  let found: Found;
  let lookup: string | undefined;
  if (mapping.key === 'company') {
    const domain = companyDomain(mapping, record);
    const name = companyName(mapping, record);
    if (!domain && (!manual || !name)) return 'no_domain';
    // Advisory: the mapped write decides under the record lock.
    if (!open.length) return 'nothing_to_fill';
    lookup = domain ?? undefined;
    found = await lookUp(ctx, {
      name,
      domain,
      context: mappedContext(mapping, record),
    });
  } else {
    if (!open.length) return 'nothing_to_fill';
    const linkedin = mapping.outputs.find(({ output }) => output === 'linkedin_url');
    const email = mapping.lookups.email ? primaryEmail(record.fields[mapping.lookups.email]) : null;
    const person: PersonRecord = {
      name: mapping.lookups.name ? nameOf(record.fields[mapping.lookups.name]) : null,
      email,
      linkedin: linkedin ? primaryUrl(record.fields[linkedin.field]) : null,
      company: null,
      details: personDetails(mapping, record),
    };
    // The company is read only when the lookup can use it.
    if (person.name || person.linkedin) person.company = await linkedCompany(ctx, mapping, record);
    lookup = email ?? undefined;
    found = await lookUpPerson(ctx, person, manual);
  }
  if (found.status === 'no_match') return found.code;
  const wanted = new Set(open.map(({ output }) => output));
  const values = Object.fromEntries(
    Object.entries(found.values).filter(([output]) => wanted.has(output)),
  );
  if (!Object.keys(values).length) return 'no_usable_values';
  const written = await ctx.sdk.extensionMappedWrite(ctx.installationId, {
    recordId: record.id,
    ...(manual ? { expectedUpdatedAt: record.updatedAt } : {}),
    ...(lookup ? { lookup } : {}),
    binding: mapping.key,
    values,
    ...(found.confidence < 1 ? { confidence: found.confidence } : {}),
  });
  return written.outcome === 'applied' ? found.code : (written.reason ?? 'skipped');
}

/** The record, or null when it was deleted or merged away. */
async function readRecord(
  sdk: RetainerClient,
  id: string,
  signal: AbortSignal,
  include?: string[],
) {
  let record: PresentedRecord;
  try {
    record = await sdk.record(id, include, signal);
  } catch (error) {
    if (error instanceof RetainerApiError && [404, 410].includes(error.status)) return null;
    throw error;
  }
  // A merged-away ID reads as its survivor, which has its own changes.
  return record.id === id ? record : null;
}

/** Each record may need a search and a model call, so pages stay small. */
const BACKFILL_PAGE = 10;
/** Records of a backfill page looked up at once, to stay well inside its 300 s. */
const BACKFILL_CONCURRENCY = 3;

const FUNCTIONS = {
  company: {
    enrich: ENRICHMENT.enrich,
    button: ENRICHMENT.enrichCompanyNow,
    backfill: ENRICHMENT.backfill,
    kv: 'mappedOutputs',
  },
  person: {
    enrich: ENRICHMENT.enrichPerson,
    button: ENRICHMENT.enrichPersonNow,
    backfill: ENRICHMENT.backfillPerson,
    kv: 'mappedPersonOutputs',
  },
} as const;
const BINDING_KEYS = Object.keys(FUNCTIONS) as EnrichmentBindingKey[];

/** Whether the company has a writable field with the output's expected API name and a compatible type. */
const hasExpectedField = (company: ObjectView, output: (typeof COMPANY_OUTPUTS)[number]) =>
  company.fields.some(
    (field) =>
      field.name === output.field.name &&
      field.name !== 'domain' &&
      !field.readOnly &&
      bindableField(field, output),
  );

/**
 * Configure (model calls spec 6.1, enrichment spec 7.4): the model suggests
 * which objects hold companies and people and where each lookup and detail
 * goes. Without a usable answer, company details are suggested by API name
 * and type, and People is left to the server's default.
 */
async function configure(ctx: Run, invocation: Invocation): Promise<ExecutionResult> {
  const { sdk, signal } = ctx;
  const reason = configureInput.safeParse(invocation.input).data?.reason;
  const current =
    reason === 'install'
      ? undefined
      : (invocation.bindings ?? (await sdk.extensionBindings(ctx.installationId, signal)));
  const { objects } = await sdk.schema();
  const suggested = await suggestBindings(
    sdk,
    {
      objects,
      bindings: ENRICHMENT_BINDINGS,
      model: ctx.model(),
      modelName: ENRICHMENT_MODEL,
      system: CONFIGURE_SYSTEM,
      current,
      fieldValues: true,
    },
    signal,
  );
  if (suggested) {
    if (Object.keys(suggested.bindings).length)
      await sdk.saveExtensionSuggestions(ctx.installationId, suggested);
    return done('suggestions_ready');
  }
  // Without a model: company details by API name and type.
  const retained = current?.bindings.company?.objects[0]?.name;
  const company =
    objects.find((object) => object.nameSingular === retained) ??
    objects.find(
      (object) =>
        object.class !== 'event' &&
        (object.nameSingular === 'company' || object.labelPlural === 'Companies'),
    );
  const fields: NonNullable<
    Extract<ExtensionBindingChoices[string], { action: 'create' }>['fields']
  > = {};
  const bindingReasons: Record<string, string> = {};
  for (const output of COMPANY_OUTPUTS) {
    const existing = company && hasExpectedField(company, output);
    fields[output.key] = existing
      ? { action: 'existing', field: output.field.name }
      : { action: 'create' };
    bindingReasons[`company.${output.key}`] = existing
      ? 'This field has the expected API name and a compatible type.'
      : 'Create the suggested field; no matching compatible API name exists.';
  }
  await sdk.saveExtensionSuggestions(ctx.installationId, {
    bindings: {
      company: company
        ? { action: 'existing', objects: [company.nameSingular], fields }
        : { action: 'create', fields },
    },
    bindingReasons,
  });
  return done('suggestions_ready_without_model');
}

/**
 * Enrichment (enrichment spec 4.4, 4.5, 7; model calls spec 6). Setup checks
 * the Exa key and queues a backfill for newly mapped outputs. Configure
 * suggests destinations. A change run reads the current company or person and
 * the approved mapping, looks it up, and sends only valid values for open
 * mapped outputs to the fill-only mapped write, which decides what is
 * written. Diagnostics carry codes only: never a domain, a name, a key, a
 * provider body or a model's answer.
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
    client ??= runModel(invocation, transport);
    return client;
  };
  const exa = () => {
    const key = process.env.EXA_API_KEY?.trim();
    if (!key) throw new ExaError('provider_not_configured');
    return new ExaProvider(key, signal, transport);
  };
  const plan = async () => invocation.bindings ?? (await sdk.extensionBindings(id, signal));
  try {
    if (invocation.functionId === ENRICHMENT.configure) {
      const provider = exa();
      await provider.check();
      return await configure({ sdk, installationId: id, exa: provider, model, signal }, invocation);
    }
    if (invocation.functionId === ENRICHMENT.setup) {
      await exa().check();
      const input = invocation.input as { previousVersion?: string | null };
      const approved = await plan();
      const saved = await Promise.all(
        BINDING_KEYS.map((key) => sdk.extensionKv(id, FUNCTIONS[key].kv)),
      );
      for (const [i, key] of BINDING_KEYS.entries()) {
        const { backfill, kv } = FUNCTIONS[key];
        const keys = mappingOf(approved, key)?.outputs.map(({ output }) => output) ?? [];
        const previous = saved[i];
        const known = Array.isArray(previous?.value) ? previous.value : [];
        await sdk.extensionCheckpoint(id, {
          children:
            input.previousVersion && keys.some((output) => !known.includes(output))
              ? [
                  {
                    functionId: backfill,
                    input: {},
                    dedupeKey: `backfill:${key}:${invocation.runId}`,
                  },
                ]
              : [],
          kv: { key: kv, expectedRevision: previous?.revision ?? null, value: keys },
        });
      }
      return { status: 'succeeded' };
    }
    const key = BINDING_KEYS.find((k) => {
      const { enrich, button, backfill } = FUNCTIONS[k];
      return [enrich, button, backfill].some((id) => id === invocation.functionId);
    });
    if (!key) return { status: 'failed', code: 'function_not_bundled' };
    const approved = await plan();
    const mapping = mappingOf(approved, key);
    const ctx = (): Context => ({
      sdk,
      installationId: id,
      exa: exa(),
      model,
      signal,
      companies: mappingOf(approved, 'company'),
    });

    if (invocation.functionId === FUNCTIONS[key].backfill) {
      const input = pageInput.parse(invocation.input);
      if (!mapping) return done('not_applicable');
      if (!mapping.usable) return { status: 'failed', code: 'schema_binding_conflict' };
      const page = await sdk.queryRecords(
        mapping.object,
        { limit: BACKFILL_PAGE, ...(input.cursor ? { cursor: input.cursor } : {}) },
        signal,
      );
      const run = ctx();
      await eachLimited(page.records, BACKFILL_CONCURRENCY, async (row) => {
        const record = await readRecord(sdk, row.id, signal);
        // Only records enriched before; a value held for review counts.
        if (
          !record ||
          !Object.values(record.provenance ?? {}).some(
            (p) => p.assertion?.actor.id === id || p.pendingAssertion?.actor.id === id,
          )
        )
          return;
        await enrichRecord(run, mapping, record);
      });
      if (page.nextCursor)
        await sdk.extensionCheckpoint(id, {
          children: [
            {
              functionId: FUNCTIONS[key].backfill,
              input: { cursor: page.nextCursor },
              dedupeKey: `backfill:${invocation.runId}`,
            },
          ],
        });
      return done('backfill_page');
    }

    let recordId: string;
    const manual = invocation.functionId === FUNCTIONS[key].button;
    if (manual) {
      const input = buttonInput.safeParse(invocation.input);
      if (!input.success) return { status: 'failed', code: 'invalid_input' };
      recordId = input.data.recordId;
    } else {
      const input = changeInput.safeParse(invocation.input);
      if (!input.success) return { status: 'failed', code: 'invalid_input' };
      const change = await sdk.change(input.data.changePosition);
      if (!change.recordId || !['create', 'update'].includes(change.operation))
        return done('not_applicable');
      recordId = change.recordId;
    }
    if (!mapping) return { status: 'failed', code: 'binding_unavailable' };
    if (!mapping.usable) return { status: 'failed', code: 'schema_binding_conflict' };
    const record = await readRecord(sdk, recordId, signal);
    if (!record) return done('record_gone');
    return done(await enrichRecord(ctx(), mapping, record, manual));
  } catch (error) {
    if (error instanceof RetainerApiError && error.code === 'stale_write')
      return done('lookup_changed');
    if (error instanceof ExaError) {
      // Exa's credential belongs to the deployment, so workspace reconnect cannot fix it.
      const code =
        error.code === 'provider_unauthorized'
          ? 'provider_credentials_rejected'
          : error.code === 'provider_not_found'
            ? 'provider_invalid_request'
            : error.code;
      return {
        status: error.retry ? 'retry' : 'failed',
        code,
        ...(error.retry ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    }
    if (error instanceof ModelRequestFailed) return { status: 'failed', code: error.message };
    if (error instanceof RetainerApiError && error.code === 'schema_binding_conflict')
      return { status: 'failed', code: 'schema_binding_conflict' };
    const retryable = transient(error);
    if (isRetryLater(retryable)) throw retryable;
    return { status: 'failed', code: 'handler_failed' };
  }
}
