import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { forbidden } from '../errors.js';
import { errorBody } from '../http/response.js';

/**
 * The hosted service puts CloudFront in front of API Gateway, so AWS WAF can
 * limit each client at the edge. CloudFront sends this header with
 * `RETAINER_EDGE_SECRET` on every request. API Gateway's own URL stays
 * reachable, so the api and control functions refuse any request without it:
 * nothing gets past the WAF.
 */
export const EDGE_SECRET_HEADER = 'x-retainer-edge-secret';

/** Where CloudFront puts the viewer's address and port, such as `198.51.100.10:46532`. */
export const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';

type HttpEvent = {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { sourceIp?: string } };
};

const matches = (sent: string | undefined, secret: string) => {
  if (sent === undefined) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Wraps a Lambda HTTP handler. Without a secret it changes nothing. With one,
 * a request whose `x-retainer-edge-secret` does not match gets 403, and the
 * header is removed before the app sees the request. API Gateway lowercases
 * header names (payload 2.0).
 */
export function requireEdge<E extends LambdaEvent, R>(
  secret: string | undefined,
  http: (event: E, context: LambdaContext) => Promise<R>,
) {
  if (secret === undefined) return http;
  return async (event: E, context: LambdaContext) => {
    const headers = (event as HttpEvent).headers ?? {};
    if (!matches(headers[EDGE_SECRET_HEADER], secret)) {
      return {
        statusCode: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          errorBody(forbidden("send requests to the service's public address, not this one")),
        ),
        isBase64Encoded: false,
      } as R;
    }
    const { [EDGE_SECRET_HEADER]: _, ...rest } = headers;
    return http({ ...event, headers: rest }, context);
  };
}

/**
 * The caller's address. Behind CloudFront (a secret is set, so `requireEdge`
 * has checked the request came through it) that is the viewer's, from
 * `CloudFront-Viewer-Address`; API Gateway's view would be a CloudFront
 * server's, shared by everyone using it. Otherwise it is API Gateway's view.
 * A header a client sent directly is never read.
 */
export function clientIpOf(event: unknown, secret: string | undefined): string | undefined {
  const http = event as HttpEvent | undefined;
  if (secret === undefined) return http?.requestContext?.http?.sourceIp;
  return viewerIp(http?.headers?.[VIEWER_ADDRESS_HEADER]);
}

/** The address in `CloudFront-Viewer-Address`: an IPv4 or IPv6 address, a colon, the port. */
export function viewerIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bracketed = /^\[([^\]]+)\]:\d+$/.exec(value);
  if (bracketed) return isIP(bracketed[1] ?? '') ? bracketed[1] : undefined;
  const colon = value.lastIndexOf(':');
  const ip = colon === -1 ? value : value.slice(0, colon);
  if (isIP(ip)) return ip;
  return isIP(value) ? value : undefined;
}
