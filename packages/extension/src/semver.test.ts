import { describe, expect, it } from 'vitest';
import { defineExtension, supportsServer } from './index.js';
import { fixture } from './index.test.js';
import { parseServerRange, satisfiesServerRange } from './semver.js';

describe('reviewed server ranges', () => {
  it('evaluates bounded comparator sets and alternatives numerically', () => {
    const range = '>=0.1.0 <0.2.0';
    expect(satisfiesServerRange('0.1.0', range)).toBe(true);
    expect(satisfiesServerRange('0.1.17', range)).toBe(true);
    expect(satisfiesServerRange('0.2.0', range)).toBe(false);
    expect(satisfiesServerRange('0.0.9', range)).toBe(false);
    expect(satisfiesServerRange('0.10.0', '>=0.9.0 <=0.10.0')).toBe(true);
    // Narrowest non-empty sets stay valid.
    expect(satisfiesServerRange('1.0.1', '>1.0.0 <1.0.2')).toBe(true);
    expect(satisfiesServerRange('1.0.1', '>1.0.0 <=1.0.1')).toBe(true);
    expect(satisfiesServerRange('1.0.0', '>=1.0.0 <=1.0.0')).toBe(true);
    expect(satisfiesServerRange('1.0.0', '>0.9.0 <1.0.0')).toBe(false);
    // A strict bound at the component ceiling carries to the next minor.
    expect(satisfiesServerRange('1.3.0', '>1.2.999999999 <=1.3.0')).toBe(true);
    expect(satisfiesServerRange('0.3.1', '>=0.1.0 <0.2.0 || 0.3.1')).toBe(true);
    expect(satisfiesServerRange('0.3.2', '>=0.1.0 <0.2.0 || =0.3.1')).toBe(false);
    // Only release versions match; a prerelease or malformed server never does.
    expect(satisfiesServerRange('0.1.1-rc.1', range)).toBe(false);
    expect(satisfiesServerRange('not-a-version', range)).toBe(false);
  });
  it('refuses unbounded, malformed and oversized ranges', () => {
    for (const invalid of [
      '>=0.1.0',
      '<0.2.0',
      '*',
      '^0.1.0',
      '~0.1.0',
      '0.1.x',
      '>=0.1.0 <0.2.0 ||',
      '>=0.2.0 <0.1.0',
      '>1.0.0 <=1.0.0',
      '>1.0.0 <1.0.1',
      // No version VERSION accepts lies above the nine-digit ceiling.
      '>1.2.999999999 <1.3.0',
      '>999999999.999999999.999999999 <=999999999.999999999.999999999',
      '>=1.0.0 <1.0.0',
      '=1.0.0 <1.0.0',
      '>=0.1.0 <0.2.0 || >1.0.0 <1.0.1',
      '>=0.1.0-rc.1 <0.2.0',
      '>= 0.1.0 <0.2.0',
      '',
      `${'>=0.1.0 <0.2.0 || '.repeat(20)}0.1.0`,
    ])
      expect(() => parseServerRange(invalid), invalid).toThrow(/unsupported_manifest/);
  });
  it('accepts either a range or an exact list in a manifest, never both or neither', () => {
    const { serverVersions: _, ...base } = fixture();
    const ranged = defineExtension({ ...base, serverRange: '>=0.1.0 <0.2.0' });
    expect(supportsServer(ranged, '0.1.9')).toBe(true);
    expect(supportsServer(ranged, '0.2.0')).toBe(false);
    const exact = defineExtension(fixture());
    expect(supportsServer(exact, '0.1.0')).toBe(true);
    expect(supportsServer(exact, '0.1.1')).toBe(false);
    expect(() => defineExtension(base)).toThrow(/exactly one of serverRange or serverVersions/);
    expect(() => defineExtension({ ...fixture(), serverRange: '>=0.1.0 <0.2.0' })).toThrow(
      /exactly one of serverRange or serverVersions/,
    );
    expect(() => defineExtension({ ...base, serverRange: '>=0.1.0' })).toThrow(/upper bound/);
  });
});
