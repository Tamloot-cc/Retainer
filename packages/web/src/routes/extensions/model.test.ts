import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { appLinksKey, initialSettings, queryKey } from './model';

const setting = { type: 'string', label: 'Days', required: true, secret: false, reconnect: false };
const release = (settings: Record<string, unknown>) =>
  ({ manifest: { settings } }) as unknown as Parameters<typeof initialSettings>[0];
const installation = (settings: Record<string, unknown>) =>
  ({ settings }) as unknown as Parameters<typeof initialSettings>[1];

describe('initialSettings', () => {
  it('starts from the release defaults, then the installation values', () => {
    expect(
      initialSettings(
        release({ days: { ...setting, type: 'number', default: 31 }, region: setting }),
        installation({ region: 'eu' }),
      ),
    ).toEqual({ days: 31, region: 'eu' });
  });

  it('leaves out a setting the release no longer defines', () => {
    expect(
      initialSettings(
        release({ days: { ...setting, type: 'number', default: 31 } }),
        installation({ days: 2, nangoIntegrationId: 'google-mail' }),
      ),
    ).toEqual({ days: 2 });
  });
});

describe('appLinksKey', () => {
  it('is refreshed with the extensions, so the sidebar shows an app as soon as it is installed', async () => {
    const client = new QueryClient();
    client.setQueryData(appLinksKey('w1'), { links: [] });
    await client.invalidateQueries({ queryKey });
    expect(client.getQueryState(appLinksKey('w1'))?.isInvalidated).toBe(true);
  });
});
