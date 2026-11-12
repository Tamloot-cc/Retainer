/**
 * The registrable host of a website value, as enrichment looks it up: the
 * hostname lowercased and in punycode, without a trailing dot or one leading
 * `www.`. A value without a scheme is read as https. Returns null for what is
 * not a public web host: another scheme, an IP literal, `localhost`, a single
 * label or an overlong name. Extensions and the server share it, so the
 * domain a run looked up and the domain a write is checked against agree.
 */
export function normalizeDomain(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // `mailto:a@b.com` read as https carries credentials; a website never does.
  if (url.username || url.password) return null;
  let host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (
    !host ||
    host.length > 253 ||
    host === 'localhost' ||
    !host.includes('.') ||
    host.startsWith('[') ||
    /^\d+(\.\d+){3}$/.test(host)
  )
    return null;
  return host;
}
