import { describe, expect, it, vi } from 'vitest';
import { clientIpOf, EDGE_SECRET_HEADER, requireEdge, viewerIp } from '../../src/lambda/edge.js';
import { context, httpEvent } from '../helpers/lambda.js';

const SECRET = 'edge-secret-0123456789abcdef0123456789';

describe('requireEdge', () => {
  it('changes nothing without a secret', async () => {
    const http = vi.fn(async () => ({ statusCode: 200 }));
    const handler = requireEdge(undefined, http);
    expect(handler).toBe(http);
  });

  it('refuses a request without the secret, or with a wrong one', async () => {
    const http = vi.fn(async () => ({ statusCode: 200 }));
    const handler = requireEdge(SECRET, http);
    const cases: Record<string, string>[] = [
      {},
      { [EDGE_SECRET_HEADER]: 'wrong' },
      { [EDGE_SECRET_HEADER]: '' },
    ];
    for (const headers of cases) {
      const res = (await handler(httpEvent('GET', '/health', { headers }), context)) as {
        statusCode: number;
        body: string;
      };
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'forbidden' } });
    }
    expect(http).not.toHaveBeenCalled();
  });

  it('passes a request with the secret on, without the header', async () => {
    const http = vi.fn(async (_event: unknown) => ({ statusCode: 200 }));
    const handler = requireEdge(SECRET, http);
    const event = httpEvent('GET', '/health', {
      headers: { [EDGE_SECRET_HEADER]: SECRET, accept: 'application/json' },
    });
    const res = await handler(event, context);
    expect(res).toEqual({ statusCode: 200 });
    const passed = http.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(passed.headers[EDGE_SECRET_HEADER]).toBeUndefined();
    expect(passed.headers.accept).toBe('application/json');
  });
});

describe('clientIpOf', () => {
  const event = httpEvent('GET', '/account', {
    headers: { 'cloudfront-viewer-address': '198.51.100.10:46532' },
  });

  it("uses API Gateway's view without a secret, ignoring the header", () => {
    expect(clientIpOf(event, undefined)).toBe('192.0.2.1');
  });

  it("uses CloudFront's view of the viewer with a secret", () => {
    expect(clientIpOf(event, SECRET)).toBe('198.51.100.10');
    expect(clientIpOf(httpEvent('GET', '/account'), SECRET)).toBeUndefined();
  });
});

describe('viewerIp', () => {
  it.each([
    ['198.51.100.10:46532', '198.51.100.10'],
    ['2001:db8::1:46532', '2001:db8::1'],
    ['[2001:db8::1]:46532', '2001:db8::1'],
    ['2001:db8::', '2001:db8::'],
    ['198.51.100.10', '198.51.100.10'],
  ])('reads %s as %s', (value, ip) => {
    expect(viewerIp(value)).toBe(ip);
  });

  it.each([undefined, '', 'not-an-address:443', '[nope]:443'])('ignores %s', (value) => {
    expect(viewerIp(value)).toBeUndefined();
  });
});
