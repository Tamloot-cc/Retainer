import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(address, prefix, 'ipv4');
const public6 = new BlockList();
public6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied.addSubnet(address, prefix, 'ipv6');
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  privateNetworks.addSubnet(address, prefix, 'ipv4');
privateNetworks.addSubnet('fc00::', 7, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !denied.check(address, 'ipv4');
  return public6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}
export type Destination = { hostname: string; port: number; address: string; family: 4 | 6 };
export class EgressPolicy {
  private readonly exceptions: Set<string>;
  constructor(
    origins: readonly string[],
    private readonly resolve = (hostname: string) =>
      lookup(hostname, { all: true, verbatim: true }),
  ) {
    this.exceptions = new Set(
      origins.map((origin) => {
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error('invalid execution API origin');
        return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
      }),
    );
  }
  async destination(hostname: string, port: number): Promise<Destination> {
    hostname = hostname.toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || hostname.includes('%'))
      throw new Error('egress denied');
    const exception = this.exceptions.has(`${hostname}:${port}`);
    if (!exception && port !== 80 && port !== 443) throw new Error('egress denied');
    const host = hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host),
      addresses = literal ? [{ address: host, family: literal }] : await this.resolve(host);
    if (
      !addresses.length ||
      addresses.some(
        ({ address, family }) =>
          !isPublicAddress(address) &&
          !(exception && privateNetworks.check(address, family === 6 ? 'ipv6' : 'ipv4')),
      )
    )
      throw new Error('egress denied');
    const chosen = addresses[0];
    if (!chosen) throw new Error('egress denied');
    return { hostname: host, port, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
  }
}
