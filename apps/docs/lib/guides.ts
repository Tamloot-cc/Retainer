import api from '../../../docs/api/meta.json' with { type: 'json' };
import cli from '../../../docs/cli/meta.json' with { type: 'json' };
import guides from '../../../docs/guides/meta.json' with { type: 'json' };
import mcp from '../../../docs/mcp/meta.json' with { type: 'json' };

// Each section's meta.json lists its pages. A `../name` entry publishes a guide from the
// root of docs/ in that section, so the file stays where GitHub readers already find it.
// Guides are served at /docs/ and the other sections under their folder name.
const sections = [
  ['guides', guides.pages, []],
  ['mcp', mcp.pages, ['mcp']],
  ['cli', cli.pages, ['cli']],
  ['api', api.pages, ['api']],
] as const;

/** Paths under docs/ without an extension, mapped to their URL slugs under /docs. */
export const guideSlugs = new Map<string, string[]>();
for (const [folder, pages, prefix] of sections) {
  for (const entry of pages) {
    if (entry.startsWith('---')) continue;
    const path = entry.startsWith('../') ? entry.slice(3) : `${folder}/${entry}`;
    const name = path.slice(path.lastIndexOf('/') + 1);
    // Preserve the existing SDK permalink when moving it into the API sidebar.
    guideSlugs.set(
      path,
      path === 'sdk' ? ['sdk'] : name === 'index' ? [...prefix] : [...prefix, name],
    );
  }
}

/** The published URL of a Markdown file under docs/, if it is a guide. */
export function guideUrl(path: string) {
  const slugs = guideSlugs.get(path.replace(/\.mdx?$/, ''));
  return slugs && `/docs/${slugs.map((slug) => `${slug}/`).join('')}`;
}
