import { describe, expect, it } from 'vitest';
import { ALLOWED_BETAS, allowedPath, refusedBeta, refusedBody } from './allowlist.js';

const query = (text = '') => new URLSearchParams(text);

describe('allowed paths (model calls spec 3.2.1)', () => {
  it('allows Messages, token counting and the models list', () => {
    for (const [method, path] of [
      ['POST', '/v1/messages'],
      ['POST', '/v1/messages/count_tokens'],
      ['GET', '/v1/models'],
      ['GET', '/v1/models/claude-opus-5-5'],
    ] as const)
      expect(allowedPath(method, path, query())).not.toHaveProperty('status');
    expect(allowedPath('POST', '/v1/messages', query('beta=true'))).not.toHaveProperty('status');
  });

  it('refuses every other path with 404, and the right path with the wrong method', () => {
    for (const [method, path] of [
      ['GET', '/v1/files'],
      ['POST', '/v1/files'],
      ['GET', '/v1/files/file_1/content'],
      ['POST', '/v1/messages/batches'],
      ['GET', '/v1/messages/batches/batch_1/results'],
      ['GET', '/v1/skills'],
      ['POST', '/v1/agents'],
      ['POST', '/v1/sessions'],
      ['GET', '/v1/organizations/api_keys'],
      ['POST', '/v1/complete'],
      ['GET', '/v1/messages'],
      ['DELETE', '/v1/models/claude-opus-5-5'],
      ['POST', '/v1/messages/'],
      ['POST', '/v1/../v1/files'],
    ])
      expect(allowedPath(method as string, path as string, query())).toMatchObject({
        status: 404,
        type: 'not_found_error',
      });
  });

  it('refuses unknown query parameters', () => {
    expect(allowedPath('POST', '/v1/messages', query('container=x'))).toMatchObject({
      status: 400,
      message: expect.stringContaining('container'),
    });
  });
});

describe('allowed body fields and content', () => {
  const ok = { model: 'claude-opus-5-5', max_tokens: 10, messages: [] };

  it('allows the listed fields', () => {
    expect(
      refusedBody({
        ...ok,
        system: 'x',
        stream: true,
        tools: [],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        fallbacks: 'default',
        mcp_servers: [],
      }),
    ).toBeUndefined();
  });

  it('refuses container, thread, diagnostics and anything unknown, naming it', () => {
    for (const field of ['container', 'thread', 'diagnostics', 'something_new'])
      expect(refusedBody({ ...ok, [field]: 'x' })).toMatchObject({
        status: 400,
        type: 'invalid_request_error',
        message: expect.stringContaining(field),
      });
  });

  it('refuses a file source at the top level and inside a tool result', () => {
    const file = { type: 'document', source: { type: 'file', file_id: 'file_1' } };
    expect(refusedBody({ ...ok, messages: [{ role: 'user', content: [file] }] })).toMatchObject({
      status: 400,
      message: expect.stringContaining('file source'),
    });
    expect(
      refusedBody({
        ...ok,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: [file] }],
          },
        ],
      }),
    ).toMatchObject({ status: 400 });
    // Other sources pass.
    expect(
      refusedBody({
        ...ok,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('refuses a body that is not an object, and survives deep nesting', () => {
    expect(refusedBody([])).toMatchObject({ status: 400 });
    expect(refusedBody('x')).toMatchObject({ status: 400 });
    let deep: unknown = { source: { type: 'file' } };
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(refusedBody({ ...ok, messages: deep })).toMatchObject({ status: 400 });
  });

  it('walks a wide array or object without overflowing the argument limit', () => {
    const wide = Array.from({ length: 300_000 }, () => null);
    expect(refusedBody({ ...ok, metadata: { wide } })).toBeUndefined();
    const keys = Object.fromEntries(wide.map((_, i) => [`k${i}`, null]));
    expect(refusedBody({ ...ok, metadata: keys })).toBeUndefined();
    expect(
      refusedBody({ ...ok, messages: [...wide, { content: [{ source: { type: 'file' } }] }] }),
    ).toMatchObject({ status: 400 });
  });
});

describe('beta flags', () => {
  it('allows listed flags alone and together', () => {
    expect(refusedBeta(null)).toBeUndefined();
    expect(refusedBeta([...ALLOWED_BETAS].join(', '))).toBeUndefined();
  });

  it('refuses an unlisted flag alone and next to an allowed one', () => {
    expect(refusedBeta('files-api-2025-04-14')).toMatchObject({
      status: 400,
      message: expect.stringContaining('files-api-2025-04-14'),
    });
    expect(refusedBeta('compact-2026-01-12,files-api-2025-04-14')).toMatchObject({ status: 400 });
    expect(refusedBeta('')).toMatchObject({ status: 400 });
  });
});
