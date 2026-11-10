import { afterEach, expect, it, vi } from 'vitest';
import { RetainerClient } from './index.js';
import { retryAfterMs } from './maintenance.js';

const maintenance = (guaranteed = false, retry = '1') =>
  Response.json(
    { error: { code: 'maintenance', message: 'retry shortly' } },
    {
      status: 503,
      headers: {
        'retry-after': retry,
        ...(guaranteed ? { 'x-retainer-maintenance': 'not-executed' } : {}),
      },
    },
  );
afterEach(() => vi.useRealTimers());
it('honors seconds and HTTP dates', () => {
  expect(retryAfterMs('3', 0)).toBe(3000);
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:04 GMT', 1000)).toBe(3000);
  expect(retryAfterMs('invalid')).toBe(5000);
});
it('retries reads and preserves a keyed write exactly', async () => {
  vi.useFakeTimers();
  for (const write of [false, true]) {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(maintenance()))
      .mockImplementationOnce(() => Promise.resolve(Response.json({ ok: true })));
    const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
    const result = write
      ? client.createRecord('person', { values: { name: 'Draft' } }, 'same-key')
      : client.schema();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  }
});
it('does not retry an unkeyed write without the not-executed guarantee', async () => {
  const fetcher = vi.fn(async () => maintenance());
  const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
  await expect(client.createRecord('person', { values: {} })).rejects.toMatchObject({
    code: 'maintenance',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retries a rejected write with the guarantee but bounds attempts', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => maintenance(true));
  const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
  const result = expect(client.createRecord('person', { values: {} })).rejects.toMatchObject({
    code: 'maintenance',
  });
  await vi.runAllTimersAsync();
  await result;
  expect(fetcher).toHaveBeenCalledTimes(13);
});
it('does not shorten a Retry-After beyond the retry budget or retry generic outages', async () => {
  for (const response of [
    maintenance(false, '120'),
    Response.json({ error: { code: 'unavailable' } }, { status: 503 }),
  ]) {
    const fetcher = vi.fn(async () => response);
    const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
    await expect(client.schema()).rejects.toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('aborts while waiting without sending another request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetcher = vi.fn(async () => maintenance());
  const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
  const result = expect(client.schema(controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await result;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('retries POST search reads without a not-executed guarantee', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => maintenance())
    .mockImplementationOnce(async () => Response.json({ results: [] }));
  const client = new RetainerClient({ baseUrl: 'https://retainer.test', fetch: fetcher });
  const result = client.search({ query: 'person' });
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
