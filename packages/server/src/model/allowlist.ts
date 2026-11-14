/**
 * What the model proxy forwards (model calls spec 3.2.1). Retainer's Anthropic
 * account is shared by every workspace, so a request must not reach anything
 * stored in it. A list of refused fields would always be behind the API, so
 * the proxy allows what it knows and refuses the rest. Adding an entry is a
 * server change with a test.
 */

/** Anthropic API paths under the proxy's base URL, by method. */
export const ALLOWED_PATHS: readonly {
  method: 'GET' | 'POST';
  pattern: RegExp;
  query: string[];
}[] = [
  { method: 'POST', pattern: /^\/v1\/messages$/, query: ['beta'] },
  { method: 'POST', pattern: /^\/v1\/messages\/count_tokens$/, query: ['beta'] },
  { method: 'GET', pattern: /^\/v1\/models$/, query: ['beta', 'limit', 'before_id', 'after_id'] },
  { method: 'GET', pattern: /^\/v1\/models\/[A-Za-z0-9._:@-]{1,200}$/, query: ['beta'] },
];

/** Top-level body fields of the two Messages paths. Not `container`, `thread` or `diagnostics`. */
export const ALLOWED_BODY_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'stop_sequences',
  'metadata',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'cache_control',
  'context_management',
  'mcp_servers',
  'fallbacks',
  'speed',
  'inference_geo',
]);

/** Beta flags for features that keep nothing in the account. */
export const ALLOWED_BETAS: ReadonlySet<string> = new Set([
  'compact-2026-01-12',
  'context-management-2025-06-27',
  'server-side-fallback-2026-07-01',
  'task-budgets-2026-03-13',
  'mcp-client-2025-11-20',
]);

export type Refusal = { status: 400 | 404; type: string; message: string };

/** The allowed path entry for a request, or a 404 refusal. */
export function allowedPath(method: string, path: string, query: URLSearchParams) {
  const entry = ALLOWED_PATHS.find((p) => p.method === method && p.pattern.test(path));
  if (!entry)
    return {
      status: 404,
      type: 'not_found_error',
      message: `${method} ${path} is not available through the model proxy`,
    } satisfies Refusal;
  for (const key of query.keys())
    if (!entry.query.includes(key))
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `query parameter ${key} is not allowed through the model proxy`,
      } satisfies Refusal;
  return entry;
}

/** Each comma-separated value of `anthropic-beta` must be on the list. */
export function refusedBeta(header: string | null): Refusal | undefined {
  if (header === null) return undefined;
  for (const flag of header.split(',').map((value) => value.trim()))
    if (!ALLOWED_BETAS.has(flag))
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `beta flag ${flag || '(empty)'} is not allowed through the model proxy`,
      };
  return undefined;
}

/** A refused top-level field, or a `file` source at any depth. */
export function refusedBody(body: unknown): Refusal | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {
      status: 400,
      type: 'invalid_request_error',
      message: 'the request body must be a JSON object',
    };
  for (const key of Object.keys(body))
    if (!ALLOWED_BODY_FIELDS.has(key))
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `field ${key} is not allowed through the model proxy`,
      };
  // Iterative, so a deep or wide body can't overflow the stack.
  const stack: unknown[] = [body];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      // One at a time: spreading a wide array overflows the argument limit.
      for (const item of value) stack.push(item);
      continue;
    }
    const source = (value as { source?: unknown }).source;
    if (source && typeof source === 'object' && (source as { type?: unknown }).type === 'file')
      return {
        status: 400,
        type: 'invalid_request_error',
        message: 'content with a file source is not allowed through the model proxy',
      };
    for (const item of Object.values(value)) stack.push(item);
  }
  return undefined;
}
