import { embedSource } from 'fumadocs-core/mdx-plugins/stringifier';
import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { commandGroups } from '../../../packages/cli/src/commands';

export function remarkCliReference() {
  return (tree: Root, file: Parameters<typeof embedSource>[0]) => {
    const index = tree.children.findIndex(
      (node) => node.type === 'mdxJsxFlowElement' && node.name === 'cli-command-reference',
    );
    const placeholder = tree.children[index];
    if (!placeholder) return;

    const markdown = commandGroups
      .map(({ title, commands }) =>
        [
          `## ${title}`,
          ...commands.map(([command, args, access, example]) =>
            [
              `### \`${command}\``,
              `\`\`\`sh title="Syntax"\nretainer ${command}${args ? ` ${args}` : ''}\n\`\`\``,
              `${access}.`,
              `\`\`\`sh title="Example"\nretainer ${example}\n\`\`\``,
            ].join('\n\n'),
          ),
        ].join('\n\n'),
      )
      .join('\n\n');

    const { children } = fromMarkdown(markdown);
    // Expose the generated commands to the normal heading, search and Markdown plugins.
    embedSource(file, placeholder, markdown, children);
    tree.children.splice(index, 1, ...children);
  };
}
