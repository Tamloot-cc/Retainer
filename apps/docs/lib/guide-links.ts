export const repository = 'https://github.com/Tamloot-cc/Retainer';

/**
 * Resolve a link written in a guide at `path` (relative to docs/): published guides use
 * their site URL, other repository files point to GitHub, and anything else passes through.
 */
export function resolveGuideLink(
  href: string,
  path: string,
  pageUrl: (path: string) => string | undefined,
): string {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(href)) return href;

  const docsRoot = `${repository}/blob/main/docs/`;
  const target = new URL(href, `${docsRoot}${path}`);
  if (target.href.startsWith(docsRoot)) {
    const targetPath = decodeURIComponent(target.pathname.slice(new URL(docsRoot).pathname.length));
    const published = pageUrl(targetPath);
    if (published) return `${published}${target.search}${target.hash}`;
  }
  return target.href;
}
