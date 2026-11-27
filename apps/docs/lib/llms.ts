import { renderPlaceholder } from 'fumadocs-core/mdx-plugins/remark-llms.runtime';
import { llms } from 'fumadocs-core/source';
import { source } from './source';

/** Markdown exports are served under this prefix, e.g. /llms.mdx/docs/mcp.md. */
export const markdownPrefix = '/llms.mdx';

export function markdownUrl(page: { url: string }) {
  return `${markdownPrefix}${page.url}.md`;
}

export const docsLlms = llms(source, {
  async renderPage(page) {
    const heading = `# ${page.data.title}\n\n`;
    if (page.type === 'openapi') {
      const { bundled } = page.data.getSchema();
      const { operations } = page.data.getOpenAPIPageProps();
      const lines =
        operations?.map(({ method, path }) => {
          const operation = bundled.paths?.[path]?.[method];
          return [
            `## \`${method.toUpperCase()} ${path}\``,
            operation?.description,
            `\`\`\`json\n${JSON.stringify(operation, null, 2)}\n\`\`\``,
          ]
            .filter(Boolean)
            .join('\n\n');
        }) ?? [];
      return `${heading}${lines.join('\n\n')}\n\n[Full OpenAPI contract](/openapi.json)\n`;
    }

    // The processed Markdown already has published links and no leading title.
    return (
      heading +
      (await renderPlaceholder(await page.data.getText('processed'), {
        Card: ({ attributes, children }) =>
          `\n- [${attributes.title}](${attributes.href})${children.trim() ? ` — ${children.trim()}` : ''}\n`,
        Callout: ({ attributes, children }) =>
          `\n\n**${attributes.title}**\n\n${children.trim()}\n\n`,
        Accordion: ({ attributes, children }) =>
          `\n\n**${attributes.title}**\n\n${children.trim()}\n\n`,
        Tab: ({ attributes, children }) => `\n\n**${attributes.value}**\n\n${children.trim()}\n\n`,
      }))
    );
  },
  renderUrl: ({ url }) => (/^\/.*\.(md|txt)$/.test(url) ? `${markdownPrefix}${url}` : url),
});

/** Serve a file that the static export always generates. */
export async function serveLlms(path: string) {
  const response = await docsLlms.serve(path);
  if (!response) throw new Error(`Missing ${path} export`);
  return response;
}
