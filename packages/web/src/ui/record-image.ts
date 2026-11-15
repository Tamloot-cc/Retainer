import { linksValueSchema } from '@retainer/shared';

const PUBLIC_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const LOCAL_SUFFIX = /\.(?:localhost|local|internal|test|example|invalid|onion|arpa)$/;

/** Only a website hostname goes to the favicon service, never the full record URL. */
export function recordImageUrl(
  enabled: boolean | undefined,
  field: string | null | undefined,
  fields: Record<string, unknown>,
): string | undefined {
  if (!enabled || !field) return;
  const result = linksValueSchema.safeParse(fields[field]);
  const primary = result.data?.primary;
  if (!primary) return;
  const url = new URL(primary.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const host = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  if (!PUBLIC_HOSTNAME.test(host) || LOCAL_SUFFIX.test(host)) return;
  return `https://twenty-icons.com/${host}`;
}
