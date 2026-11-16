import type { ExtensionManifest } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { connectionMethods, type ExtensionOAuthClients } from './oauth-clients.js';

const id = '54326882-cc28-4983-a5fe-cf0298520b68';
const oauth = { verifierSetting: 'v', codeSetting: 'c', tokenSetting: 't' };
const manifest = (extra: Partial<ExtensionManifest> = {}) =>
  ({ connection: 'member', universalId: id, ...extra }) as Pick<
    ExtensionManifest,
    'connection' | 'oauth' | 'universalId'
  >;
const clients = (keyFallback: boolean) =>
  new Map([[id, { keyFallback }]]) as unknown as ExtensionOAuthClients;

describe('connectionMethods', () => {
  it('offers the key alone without OAuth in the release', () => {
    expect(connectionMethods(manifest(), new Map(), true)).toEqual(['key']);
  });
  it('offers OAuth and the key when both exist', () => {
    const m = manifest({ oauth: { ...oauth, keySetting: 'apiKey' } as ExtensionManifest['oauth'] });
    expect(connectionMethods(m, clients(true), true)).toEqual(['oauth', 'key']);
    expect(connectionMethods(m, clients(false), true)).toEqual(['oauth']);
    expect(connectionMethods(m, new Map(), true)).toEqual(['key']);
  });
  it('never offers a key method a release without keySetting cannot use', () => {
    const m = manifest({ oauth: oauth as ExtensionManifest['oauth'] });
    expect(connectionMethods(m, clients(true), true)).toEqual(['oauth']);
    expect(connectionMethods(m, new Map(), true)).toEqual([]);
    expect(connectionMethods(m, clients(true), false)).toEqual([]);
  });
});
