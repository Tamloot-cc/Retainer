import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretCipher } from './secrets.js';

const identity = {
  workspaceId: 'workspace',
  installationId: 'installation',
  registrationId: 'registration',
  name: 'apiKey',
};
describe('authenticated versioned extension secrets', () => {
  it('authenticates tenant, installation, registration and setting identity', () => {
    const cipher = new SecretCipher('v1', new Map([['v1', randomBytes(32)]]));
    const encrypted = cipher.encrypt('fixture credential', identity);
    expect(cipher.decrypt(encrypted, identity)).toBe('fixture credential');
    for (const key of Object.keys(identity))
      expect(() => cipher.decrypt(encrypted, { ...identity, [key]: 'different' })).toThrow(
        'cannot be decrypted',
      );
    expect(() => cipher.decrypt({ ...encrypted, ciphertext: 'invalid' }, identity)).toThrow(
      'cannot be decrypted',
    );
  });
  it('retains old key versions for rotation, copies key buffers and uses fresh nonces', () => {
    const old = randomBytes(32),
      next = randomBytes(32);
    const first = new SecretCipher('old', new Map([['old', old]]));
    const value = first.encrypt('fixture', identity);
    old.fill(0);
    expect(first.decrypt(value, identity)).toBe('fixture');
    const second = new SecretCipher('new', new Map([['new', next]]));
    expect(() => second.decrypt(value, identity)).toThrow('cannot be decrypted');
    expect(first.encrypt('fixture', identity).iv).not.toBe(value.iv);
    expect(() => new SecretCipher('v1', new Map([['v1', randomBytes(16)]]))).toThrow('32 bytes');
  });
});
