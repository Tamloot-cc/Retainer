import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  accessText,
  appLinksKey,
  initialSettings,
  optionLabel,
  queryKey,
  sharingNote,
} from './model';

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

describe('plain words before and during setup', () => {
  it('names the options of the settings the platform acts on', () => {
    expect(optionLabel('onSourceDelete', 'retract')).toBe('Remove what was imported');
    expect(optionLabel('onSourceDelete', 'keep')).toBe('Keep what was imported');
    expect(optionLabel('createPeople', 'contacted_first')).toBe('Only people you contacted first');
    expect(optionLabel('region', 'eu_west')).toBe('Eu west');
  });
  it('says what a source shares with the workspace, and nothing for other extensions', () => {
    const source = { provider: 'tamloot' } as never;
    expect(sharingNote({ source, connection: 'member' }, 'Tamloot')).toBe(
      'Each member connects their own Tamloot account. What it imports from them is visible to everyone in this workspace.',
    );
    expect(sharingNote({ source, connection: 'workspace' }, 'Granola')).toBe(
      'What it imports from Granola is visible to everyone in this workspace.',
    );
    expect(sharingNote({ connection: 'workspace' }, 'Exa')).toBeUndefined();
  });
  it('says when model use sends data, from the functions that use it', () => {
    const configure = {
      functions: [{ uses: ['model'], trigger: { kind: 'configure' } }],
    } as never;
    expect(accessText(['read'], 'integration', ['model'], configure)).toContain(
      'To suggest how to set it up, this extension sends the workspace data it needs',
    );
    expect(accessText(['read'], 'integration', ['model'])).toContain(
      'This extension can send the workspace data it works on to Anthropic',
    );
  });
});
