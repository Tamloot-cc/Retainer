import { randomUUID } from 'node:crypto';
import { type Invocation, RetryLater } from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';
import { describe, expect, it } from 'vitest';
import { LAST_CONTACT } from './last-contact.js';
import { apiFetch, settle, transient } from './outcome.js';
import { execute } from './registry.js';

const live = () => new AbortController().signal;
const aborted = () => AbortSignal.abort();
describe('handler outcome classification', () => {
  it('fails a handler exception for good unless the handler asks for a retry', async () => {
    await expect(settle(() => Promise.reject(new Error('bad input')), live())).resolves.toEqual({
      status: 'failed',
      code: 'handler_failed',
    });
    await expect(
      settle(
        () => Promise.reject(new RetryLater({ code: 'provider_busy', retryAfterSeconds: 12.2 })),
        live(),
      ),
    ).resolves.toEqual({ status: 'retry', code: 'provider_busy', retryAfterSeconds: 13 });
    await expect(settle(async () => ({ status: 'retry', code: 'later' }), live())).resolves.toEqual(
      { status: 'retry', code: 'later' },
    );
  });
  it('matches RetryLater by name and never forwards an invalid code or hint', async () => {
    const copy = Object.assign(new Error('x'), { name: 'RetryLater', code: 'Bad Code!' });
    await expect(settle(() => Promise.reject(copy), live())).resolves.toEqual({
      status: 'retry',
      code: 'retry_later',
    });
    await expect(
      settle(() => Promise.reject(new RetryLater({ retryAfterSeconds: 99999 })), live()),
    ).resolves.toEqual({ status: 'retry', code: 'retry_later', retryAfterSeconds: 3600 });
  });
  it('reports a deadline abort as a timeout even when the handler swallowed it', async () => {
    await expect(settle(() => Promise.reject(new Error('aborted')), aborted())).resolves.toEqual({
      status: 'retry',
      code: 'execution_timeout',
    });
    await expect(
      settle(async () => ({ status: 'failed', code: 'provider_invalid_response' }), aborted()),
    ).resolves.toEqual({ status: 'retry', code: 'execution_timeout' });
    await expect(settle(async () => ({ status: 'succeeded' }), aborted())).resolves.toEqual({
      status: 'succeeded',
    });
  });
  it('retries Retainer outages, rate limits, conflicts and lost connections only', () => {
    for (const status of [429, 500, 503])
      expect(transient(new RetainerApiError(status, 'x', 'x'))).toBeInstanceOf(RetryLater);
    for (const status of [400, 403, 404, 422])
      expect(transient(new RetainerApiError(status, 'x', 'x'))).not.toBeInstanceOf(RetryLater);
    for (const code of ['revision_conflict', 'source_revision_conflict', 'lease_expired'])
      expect(transient(new RetainerApiError(409, code, 'x'))).toBeInstanceOf(RetryLater);
    for (const code of ['idempotency_conflict', 'installation_disabled', 'suppressed'])
      expect(transient(new RetainerApiError(409, code, 'x'))).not.toBeInstanceOf(RetryLater);
    expect(transient(new TypeError('fetch failed'))).toBeInstanceOf(RetryLater);
    expect(transient(new TypeError('x is undefined'))).not.toBeInstanceOf(RetryLater);
    // A handler's own parse error is a bug, not an outage.
    expect(transient(new SyntaxError('Unexpected token'))).not.toBeInstanceOf(RetryLater);
  });
  it('retries a Retainer API reply that is not JSON, and passes JSON replies through', async () => {
    const signal = new AbortController().signal;
    const html = apiFetch(async () => new Response('<html>502</html>', { status: 502 }), signal);
    await expect(html('https://retainer.test/v1/x')).rejects.toBeInstanceOf(RetryLater);
    const json = apiFetch(async () => Response.json({ ok: true }, { status: 201 }), signal);
    const reply = await json('https://retainer.test/v1/x');
    expect(reply.status).toBe(201);
    expect(await reply.json()).toEqual({ ok: true });
  });
  it('makes a bundled adapter retry an API outage and fail a rejected request', async () => {
    const run = (status: number): Invocation => ({
      protocolVersion: 1,
      runId: randomUUID(),
      attempt: 1,
      installationId: randomUUID(),
      releaseDigest: 'a'.repeat(64),
      functionId: LAST_CONTACT.scan,
      input: {},
      apiOrigin: 'https://retainer.test',
      runToken: `rt_run_${status}`,
      deadline: new Date(Date.now() + 60000).toISOString(),
    });
    const reply = (status: number) => async () =>
      Response.json({ error: { code: 'x', message: 'x' } }, { status });
    const signal = live();
    const outcome = (status: number) =>
      settle(() => execute(run(status), signal, reply(status)), signal);
    await expect(outcome(503)).resolves.toEqual({ status: 'retry', code: 'api_unavailable' });
    await expect(outcome(429)).resolves.toEqual({ status: 'retry', code: 'api_rate_limited' });
    await expect(outcome(403)).resolves.toEqual({ status: 'failed', code: 'handler_failed' });
    await expect(outcome(409)).resolves.toEqual({ status: 'failed', code: 'handler_failed' });
    const proxy = async () => new Response('<html>Bad gateway</html>', { status: 502 });
    await expect(settle(() => execute(run(502), signal, proxy), signal)).resolves.toEqual({
      status: 'retry',
      code: 'api_unavailable',
    });
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(settle(() => execute(run(0), signal, offline), signal)).resolves.toEqual({
      status: 'retry',
      code: 'api_unavailable',
    });
  });
});
