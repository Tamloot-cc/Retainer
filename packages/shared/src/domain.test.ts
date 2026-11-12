import { describe, expect, it } from 'vitest';
import { normalizeDomain } from './domain.js';

describe('normalizeDomain', () => {
  it.each([
    ['https://www.plurai.ai/', 'plurai.ai'],
    ['acme.com', 'acme.com'],
    ['ACME.com.', 'acme.com'],
    ['http://Sub.Acme.co.uk/path?q=1', 'sub.acme.co.uk'],
    ['  www.acme.io  ', 'acme.io'],
    ['https://bücher.de', 'xn--bcher-kva.de'],
    ['https://acme.com:8443/x', 'acme.com'],
  ])('%s → %s', (input, expected) => expect(normalizeDomain(input)).toBe(expected));

  it.each([
    '',
    'localhost',
    'http://localhost:3000',
    'intranet',
    'ftp://acme.com',
    'mailto:a@acme.com',
    'https://10.0.0.1',
    'http://[::1]/',
    'https://',
    `${'a'.repeat(250)}.com`,
  ])('refuses %j', (input) => expect(normalizeDomain(input)).toBeNull());
});
