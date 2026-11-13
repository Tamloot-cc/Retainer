import { defineExtension } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tamlootSummary } from './tamloot.js';
import { TAMLOOT, tamlootManifest, tamlootRevision, tamlootSession } from './tamloot-contract.js';
import { TamlootProvider } from './tamloot-provider.js';

describe('Tamloot release and provider boundaries', () => {
  it('pins member scope, integration attribution, everyone default and managed task fields', () => {
    const manifest = tamlootManifest({
      packageDigest: 'a'.repeat(64),
      handlerDigest: 'b'.repeat(64),
      serverRange: '>=0.1.0 <0.2.0',
    });
    expect(manifest).toMatchObject({
      connection: 'member',
      requestedActor: 'integration',
      createPeople: 'everyone',
      onSourceDelete: 'retract',
    });
    expect(manifest.settings.createPeople.default).toBe('everyone');
    expect(manifest.settings.createPeople.options).toEqual(['never', 'everyone']);
    expect(manifest.source?.tasks?.identityFieldId).toBe(TAMLOOT.taskIdField);
    expect(manifest.settings.apiKey.level).toBe('connection');
    expect(() => defineExtension({ ...manifest, schema: [] })).toThrow(
      'contributed unique text field',
    );
    expect(() =>
      defineExtension({
        ...manifest,
        source: {
          ...manifest.source,
          tasks: { ...manifest.source!.tasks, titleFieldId: TAMLOOT.taskIdField },
        },
      }),
    ).toThrow('distinct');
  });
  it('rejects unsafe JSON revisions and preserves long notes in source order', () => {
    expect(tamlootRevision.parse(123)).toBe('123');
    expect(tamlootRevision.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(tamlootRevision.safeParse('123').success).toBe(false);
    const content = 'a'.repeat(25000);
    expect(
      tamlootSummary([
        { title: 'First', content },
        { title: null, content: 'Last' },
      ]),
    ).toBe(`## First\n\n${content}\n\nLast`);
    expect(tamlootSession.safeParse({ data: { revision: -1 } }).success).toBe(false);
  });
  it('uses the fixed origin, rejects redirects and never exposes response bodies', async () => {
    const calls: unknown[] = [];
    const transport: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        redirect: init?.redirect,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({ secret: 'do not expose' }, { status: 401 });
    };
    const provider = new TamlootProvider('private-key', new AbortController().signal, transport);
    await expect(provider.request('/v1/me', z.unknown())).rejects.toMatchObject({
      code: 'provider_unauthorized',
      message: 'provider_unauthorized',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.tamloot.cc/v1/me',
        redirect: 'error',
        authorization: 'Bearer private-key',
      },
    ]);
    await expect(provider.request('https://attacker.test', z.unknown())).rejects.toMatchObject({
      code: 'invalid_provider_path',
    });
  });
  it('honors rate limits and distinguishes cursor expiry from definitive session deletion', async () => {
    for (const [path, status, code] of [
      ['/v1/changes', 410, 'provider_cursor_expired'],
      ['/v1/sessions/12345678-1234-1234-1234-123456789abc', 404, 'provider_session_deleted'],
      ['/v1/me', 429, 'provider_rate_limited'],
    ] as const) {
      const provider = new TamlootProvider('key', new AbortController().signal, async () =>
        Response.json({}, { status, headers: { 'retry-after': '120' } }),
      );
      await expect(provider.request(path, z.unknown())).rejects.toMatchObject({
        code,
        ...(status === 429 ? { retry: true, retryAfterSeconds: 120 } : {}),
      });
    }
  });
  it('rejects oversized and malformed provider bodies', async () => {
    for (const body of ['not json', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      const provider = new TamlootProvider(
        'key',
        new AbortController().signal,
        async () => new Response(body),
      );
      await expect(provider.request('/v1/me', z.unknown())).rejects.toMatchObject({
        code: body.length > 100 ? 'provider_content_too_large' : 'provider_invalid_response',
      });
    }
  });
});
