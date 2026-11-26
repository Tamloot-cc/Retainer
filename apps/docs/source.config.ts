import { relative, resolve } from 'node:path';
import { replaceSource } from 'fumadocs-core/mdx-plugins/stringifier';
import { pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { resolveGuideLink } from './lib/guide-links';
import { guideSlugs, guideUrl } from './lib/guides';

const dir = '../../docs';
type VFile = Parameters<typeof replaceSource>[0];

export const docs = defineDocs({
  dir,
  docs: {
    files: [...guideSlugs.keys()].map((path) => `${path}.{md,mdx}`),
    postprocess: {
      includeProcessedMarkdown: {
        output: 'string',
        headingIds: false,
        mdxAsPlaceholder: ['Card', 'Cards', 'Tab', 'Tabs', 'Step', 'Steps'],
      },
    },
    schema({ source }) {
      const heading = /^# (.+)/.exec(source.trimStart())?.[1]?.trim();
      return heading
        ? pageSchema.extend({ title: pageSchema.shape.title.default(heading) })
        : pageSchema;
    },
  },
  meta: { files: ['meta.json', 'guides/meta.json', 'mcp/meta.json', 'api/meta.json'] },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      () => (tree: Root, file: VFile) => {
        // DocsTitle renders the title on the website, while GitHub uses the first heading.
        const first = tree.children[0];
        if (first?.type === 'heading' && first.depth === 1) {
          tree.children.shift();
          replaceSource(file, first, '', 'markdown');
        }

        // Links between guides are written for GitHub. Point them at the published pages,
        // in both the rendered page and its Markdown export.
        const path = relative(resolve(dir), file.path);
        visit(tree, ['link', 'definition'], (node) => {
          if (node.type !== 'link' && node.type !== 'definition') return;
          const authored = node.url;
          node.url = resolveGuideLink(authored, path, guideUrl);
          if (node.url === authored) return;
          replaceSource(
            file,
            node,
            (s) => {
              const range = s.range(node);
              const markdown = range ? s.slice(range.start, range.end) : '';
              const at = markdown.lastIndexOf(authored);
              return `${markdown.slice(0, at)}${node.url}${markdown.slice(at + authored.length)}`;
            },
            'markdown',
          );
        });
      },
    ],
  },
});
