import { describe, expect, it } from 'vitest';
import { recordImageUrl } from './record-image.js';

const withWebsite = (url: string) => ({ homepage: { primary: { url } } });

describe('recordImageUrl', () => {
  it('uses the configured field and strips everything except the website hostname', () => {
    expect(
      recordImageUrl(true, 'homepage', withWebsite('https://www.MindMe.co.il:443/p?q=s#abc')),
    ).toBe('https://twenty-icons.com/mindme.co.il');
  });

  it('requires workspace opt-in, a field and a primary link', () => {
    const data = withWebsite('https://mindme.co.il');
    expect(recordImageUrl(false, 'homepage', data)).toBeUndefined();
    expect(recordImageUrl(undefined, 'homepage', data)).toBeUndefined();
    expect(recordImageUrl(true, null, data)).toBeUndefined();
    expect(recordImageUrl(true, 'website', data)).toBeUndefined();
    expect(
      recordImageUrl(true, 'homepage', {
        homepage: { primary: null, additional: [data.homepage.primary] },
      }),
    ).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'https://localhost',
    'https://myapp.internal',
    'https://127.0.0.1',
    'https://[::1]',
    'https://no-logo.invalid',
    'not a URL',
  ])('does not send %s to the favicon service', (url) => {
    expect(recordImageUrl(true, 'homepage', withWebsite(url))).toBeUndefined();
  });
});
