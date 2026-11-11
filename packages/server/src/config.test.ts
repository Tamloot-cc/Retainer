import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountsConfig,
  accountsMode,
  CONTROL_ROLE,
  loadConfig,
  ownerDatabaseUrl,
  publicOriginSchema,
  RUNTIME_ROLE,
  signInProviders,
} from './config.js';
import { runtimeConnection } from './db/client.js';

describe('immutable operator release files', () => {
  it('loads bounded catalog/executable JSON without mutating the supplied environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-release-config-'));
    try {
      const path = join(directory, 'catalog.json');
      writeFileSync(path, '[{"fixture":true}]');
      const env = {
        DATABASE_URL: 'postgres://localhost/test',
        RETAINER_EXTENSION_CATALOG_FILE: path,
        RETAINER_EXTENSION_EXECUTABLES_FILE: path,
      };
      const config = loadConfig(env);
      expect(config.RETAINER_EXTENSION_CATALOG).toBe('[{"fixture":true}]');
      expect(config.RETAINER_EXTENSION_EXECUTABLES).toBe('[{"fixture":true}]');
      expect(env).not.toHaveProperty('RETAINER_EXTENSION_CATALOG');
      expect(() => loadConfig({ ...env, RETAINER_EXTENSION_CATALOG: '[]' })).toThrow('only one');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuses missing, oversized and non-file sources without including their contents in errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-release-invalid-'));
    try {
      const large = join(directory, 'large.json');
      writeFileSync(large, 'sensitive'.repeat(300000));
      for (const path of [directory, large, join(directory, 'missing')])
        expect(() =>
          loadConfig({
            DATABASE_URL: 'postgres://localhost/test',
            RETAINER_EXTENSION_CATALOG_FILE: path,
          }),
        ).toThrow(
          'cannot load bounded operator release configuration: RETAINER_EXTENSION_CATALOG_FILE',
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('public browser origin configuration', () => {
  it('normalizes an explicit origin and allows an unset Compose variable', () => {
    expect(publicOriginSchema.parse('https://Retainer.example:443/')).toBe(
      'https://retainer.example',
    );
    expect(
      loadConfig({ DATABASE_URL: 'postgres://localhost/test', RETAINER_PUBLIC_ORIGIN: '' })
        .RETAINER_PUBLIC_ORIGIN,
    ).toBeUndefined();
  });
  it('rejects values that are not HTTP origins', () => {
    for (const origin of [
      'null',
      'file:///tmp/app',
      'https://user:pass@retainer.example',
      'https://retainer.example/app',
      'https://retainer.example?x=1',
      'https://retainer.example/#x',
    ])
      expect(publicOriginSchema.safeParse(origin).success).toBe(false);
  });
});

describe('database URLs', () => {
  const runtime = 'postgres://retainer_app:s3cret@localhost/test';

  it('needs at least one of the two URLs', () => {
    expect(() => loadConfig({})).toThrow(
      'set DATABASE_URL, RETAINER_RUNTIME_DATABASE_URL or RETAINER_CONTROL_DATABASE_URL',
    );
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow('DATABASE_URL');
  });

  it('runs the API on the runtime URL alone, without the owner', () => {
    const config = loadConfig({ RETAINER_RUNTIME_DATABASE_URL: runtime });
    expect(runtimeConnection(config)).toEqual({ url: runtime });
    expect(() => ownerDatabaseUrl(config)).toThrow('DATABASE_URL is required');
  });

  it('switches to the runtime role on the owner URL when no runtime URL is set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://retainer:pw@localhost/test' });
    expect(runtimeConnection(config)).toEqual({
      url: 'postgres://retainer:pw@localhost/test',
      role: RUNTIME_ROLE,
    });
  });

  it('refuses a runtime URL for another role, or without a usable password', () => {
    const load = (url: string) => () => loadConfig({ RETAINER_RUNTIME_DATABASE_URL: url });
    expect(load('postgres://retainer:pw@localhost/test')).toThrow('log in as retainer_app');
    for (const url of [
      'postgres://retainer_app@localhost/test',
      'postgres://retainer_app:two%20words@localhost/test',
      'postgres://retainer_app:p%C3%A4ss@localhost/test',
    ])
      expect(load(url)).toThrow('include a password of printable ASCII');
  });
});

describe('accounts mode', () => {
  const base = { DATABASE_URL: 'postgres://retainer:pw@localhost/test' };
  const secret = 'a'.repeat(32);

  it('is off without a secret, and on with one', () => {
    expect(accountsMode(loadConfig(base))).toBe(false);
    expect(accountsMode(loadConfig({ ...base, RETAINER_AUTH_SECRET: secret }))).toBe(true);
  });

  it('refuses a Google client without the secret, or half a client', () => {
    expect(() =>
      loadConfig({
        ...base,
        RETAINER_GOOGLE_CLIENT_ID: 'id',
        RETAINER_GOOGLE_CLIENT_SECRET: 'shh',
      }),
    ).toThrow('a Google client needs RETAINER_AUTH_SECRET too');
    expect(() =>
      loadConfig({ ...base, RETAINER_AUTH_SECRET: secret, RETAINER_GOOGLE_CLIENT_ID: 'id' }),
    ).toThrow('together');
    expect(() => loadConfig({ ...base, RETAINER_AUTH_SECRET: 'short' })).toThrow('32');
  });

  it('refuses a Microsoft client without the secret, or half a client', () => {
    expect(() =>
      loadConfig({
        ...base,
        RETAINER_MICROSOFT_CLIENT_ID: 'ms-id',
        RETAINER_MICROSOFT_CLIENT_SECRET: 'ms-shh',
      }),
    ).toThrow('a Microsoft client needs RETAINER_AUTH_SECRET too');
    expect(() =>
      loadConfig({ ...base, RETAINER_AUTH_SECRET: secret, RETAINER_MICROSOFT_CLIENT_ID: 'ms-id' }),
    ).toThrow('RETAINER_MICROSOFT_CLIENT_ID and RETAINER_MICROSOFT_CLIENT_SECRET together');
  });

  it('refuses to sign people in without Google or Microsoft', () => {
    const apiOnly = loadConfig({ ...base, RETAINER_AUTH_SECRET: secret });
    expect(() => accountsConfig(apiOnly)).toThrow('at least one provider');
  });

  it('signs people in with Google, Microsoft or both', () => {
    const google = { RETAINER_GOOGLE_CLIENT_ID: 'id', RETAINER_GOOGLE_CLIENT_SECRET: 'shh' };
    const microsoft = {
      RETAINER_MICROSOFT_CLIENT_ID: 'ms-id',
      RETAINER_MICROSOFT_CLIENT_SECRET: 'ms-shh',
    };
    const withSecret = { ...base, RETAINER_AUTH_SECRET: secret };
    // An install that set Google before Microsoft existed is unchanged.
    const googleOnly = accountsConfig(loadConfig({ ...withSecret, ...google }));
    expect(googleOnly).toEqual({ secret, google: { clientId: 'id', clientSecret: 'shh' } });
    expect(signInProviders(googleOnly)).toEqual(['google']);

    const microsoftOnly = accountsConfig(loadConfig({ ...withSecret, ...microsoft }));
    expect(microsoftOnly).toEqual({
      secret,
      microsoft: { clientId: 'ms-id', clientSecret: 'ms-shh' },
    });
    expect(signInProviders(microsoftOnly)).toEqual(['microsoft']);

    const both = accountsConfig(loadConfig({ ...withSecret, ...google, ...microsoft }));
    expect(signInProviders(both)).toEqual(['google', 'microsoft']);
  });

  it('runs the control function on the control login alone', () => {
    const control = `postgres://${CONTROL_ROLE}:s3cret@localhost/test`;
    const config = loadConfig({
      RETAINER_CONTROL_DATABASE_URL: control,
      RETAINER_AUTH_SECRET: secret,
      RETAINER_GOOGLE_CLIENT_ID: 'id',
      RETAINER_GOOGLE_CLIENT_SECRET: 'shh',
    });
    expect(config.RETAINER_CONTROL_DATABASE_URL).toBe(control);
    expect(() => ownerDatabaseUrl(config)).toThrow('DATABASE_URL is required');
  });

  it('takes a control login only for the control role', () => {
    expect(() =>
      loadConfig({ ...base, RETAINER_CONTROL_DATABASE_URL: 'postgres://retainer_app:pw@h/db' }),
    ).toThrow(`log in as ${CONTROL_ROLE}`);
  });
});
