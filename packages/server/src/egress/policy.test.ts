import { describe, expect, it } from 'vitest';
import { EgressPolicy, isPublicAddress } from './policy.js';

describe('execution egress policy', () => {
  it('refuses private, loopback, link-local, mapped, multicast and documentation addresses', () => {
    for (const address of [
      '0.0.0.0',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.1.2',
      '192.168.1.2',
      '169.254.169.254',
      '100.100.100.200',
      '224.0.0.1',
      '198.18.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1',
      '2002:7f00:1::',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])
      expect(isPublicAddress(address), address).toBe(true);
  });
  it('pins a public resolution and rejects mixed DNS answers rather than choosing a safe-looking one', async () => {
    const pinned = new EgressPolicy([], async () => [{ address: '1.1.1.1', family: 4 }]);
    expect(await pinned.destination('public.example', 443)).toEqual({
      hostname: 'public.example',
      port: 443,
      address: '1.1.1.1',
      family: 4,
    });
    const mixed = new EgressPolicy([], async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(mixed.destination('public.example', 443)).rejects.toThrow('denied');
    await expect(pinned.destination('public.example', 5432)).rejects.toThrow('denied');
  });
  it('permits only the configured private API authority, never metadata or loopback even as an exception', async () => {
    const policy = new EgressPolicy(['http://api:8787'], async () => [
      { address: '172.20.0.10', family: 4 },
    ]);
    expect((await policy.destination('api', 8787)).address).toBe('172.20.0.10');
    await expect(policy.destination('database', 8787)).rejects.toThrow('denied');
    await expect(policy.destination('api', 5432)).rejects.toThrow('denied');
    for (const address of ['127.0.0.1', '169.254.169.254', 'fe80::1']) {
      const blocked = new EgressPolicy(['http://api:8787'], async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]);
      await expect(blocked.destination('api', 8787)).rejects.toThrow('denied');
    }
  });
});
