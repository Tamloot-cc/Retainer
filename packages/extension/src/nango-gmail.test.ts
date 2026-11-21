import { describe, expect, it } from 'vitest';
import { nangoGmailIntegrationId } from './nango-gmail.js';

describe('nangoGmailIntegrationId', () => {
  it('defaults to google-mail', () => {
    expect(nangoGmailIntegrationId({})).toBe('google-mail');
    expect(nangoGmailIntegrationId({ RETAINER_GMAIL_NANGO_INTEGRATION_ID: '' })).toBe(
      'google-mail',
    );
  });

  it('uses the configured integration', () => {
    expect(nangoGmailIntegrationId({ RETAINER_GMAIL_NANGO_INTEGRATION_ID: 'retainer-gmail' })).toBe(
      'retainer-gmail',
    );
  });

  it('rejects a malformed ID', () => {
    expect(nangoGmailIntegrationId({ RETAINER_GMAIL_NANGO_INTEGRATION_ID: 'a/b' })).toBeNull();
  });
});
