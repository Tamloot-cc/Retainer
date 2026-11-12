import { type ExecutionResult, type Invocation, isRetryLater } from '@retainer/extension';
import { RetainerApiError, RetainerClient } from '@retainer/sdk';
import { normalizeDomain } from '@retainer/shared';
import { z } from 'zod';
import { ENRICHMENT } from './enrichment-contract.js';
import { ExaError, ExaProvider } from './enrichment-provider.js';
import { apiFetch, transient } from './outcome.js';

export { ENRICHMENT_FUNCTION_IDS, enrichmentManifest } from './enrichment-contract.js';

const changeInput = z.strictObject({ changePosition: z.string().max(19) });
const done = (code: string): ExecutionResult => ({ status: 'succeeded', code });

/** The primary URL of a links value, if it has one. */
function primaryUrl(value: unknown): string | null {
  const url = (value as { primary?: { url?: unknown } | null } | null)?.primary?.url;
  return typeof url === 'string' ? url : null;
}

/**
 * Company enrichment (spec 4.4, 4.5). Setup checks the Exa key. A change run
 * reads the current company and the approved mapping, looks the domain up in
 * Exa, and sends only valid values for mapped outputs to the fill-only mapped
 * write, which decides what is written. Diagnostics carry codes only: never a
 * domain, a key or a provider body.
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
  try {
    if (invocation.functionId === ENRICHMENT.setup) {
      const key = await sdk.extensionSecret(id, 'apiKey');
      await new ExaProvider(key.value, signal, transport).check();
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
    const key = await sdk.extensionSecret(id, 'apiKey');
    const found = await new ExaProvider(key.value, signal, transport).lookup(domain);
    if (found.status === 'no_match') return done('no_match');
    const wanted = new Set(open.map((output) => output.output));
    const values = Object.fromEntries(
      Object.entries(found.values).filter(([output]) => wanted.has(output)),
    );
    if (!Object.keys(values).length) return done('no_usable_values');
    const written = await sdk.extensionMappedWrite(id, {
      recordId: change.recordId,
      lookup: domain,
      values,
    });
    return done(written.outcome === 'applied' ? 'applied' : (written.reason ?? 'skipped'));
  } catch (error) {
    if (error instanceof ExaError)
      return {
        status: error.retry ? 'retry' : 'failed',
        code: error.code === 'provider_not_found' ? 'provider_invalid_request' : error.code,
        ...(error.retry ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    if (error instanceof RetainerApiError && error.code === 'schema_binding_conflict')
      return { status: 'failed', code: 'schema_binding_conflict' };
    const retryable = transient(error);
    if (isRetryLater(retryable)) throw retryable;
    return { status: 'failed', code: 'handler_failed' };
  }
}
