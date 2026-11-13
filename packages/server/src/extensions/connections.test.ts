import { describe, expect, it } from 'vitest';
import { validateConnectionSettings } from './connections.js';

const flags = { secret: false, reconnect: false, required: true };
const manifest = {
  settings: {
    share: { ...flags, type: 'boolean' as const, label: 'Share', consent: true },
    days: {
      ...flags,
      type: 'number' as const,
      label: 'Days',
      level: 'connection' as const,
      default: 31,
    },
    key: {
      ...flags,
      type: 'string' as const,
      label: 'Key',
      level: 'connection' as const,
      secret: true,
    },
    mode: {
      ...flags,
      type: 'string' as const,
      label: 'Mode',
      level: 'connection' as const,
      required: false,
      options: ['recent', 'all'],
    },
  },
};
describe('connection setting authority', () => {
  it('accepts only connection-level non-secret values and leaves installation consent to the admin', () => {
    expect(() => validateConnectionSettings(manifest, { days: 31, mode: 'recent' })).not.toThrow();
    for (const input of [
      { days: 31, share: true },
      { days: 31, key: 'plaintext' },
      { days: 31, unknown: true },
      { days: '31' },
      { days: 31, mode: 'invalid' },
    ] as Record<string, string | number | boolean>[])
      expect(() => validateConnectionSettings(manifest, input)).toThrow('connection setting');
  });
  it('requires explicit settings despite a form default and bounds their serialized size', () => {
    expect(() => validateConnectionSettings(manifest, {})).toThrow('required connection setting');
    expect(() =>
      validateConnectionSettings(manifest, { days: 31, mode: 'x'.repeat(65536) }),
    ).toThrow('64 KiB');
  });
});
