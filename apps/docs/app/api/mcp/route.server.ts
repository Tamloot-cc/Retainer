// Served only by the server build: next.config.mjs adds the `server.ts` page extension there.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { registerSearchTool, registerSourceTools } from 'fumadocs-core/mcp';
import { docsLlms, markdownPrefix } from '@/lib/llms';
import { docsSearch } from '@/lib/search';
import { source } from '@/lib/source';

export const runtime = 'nodejs';

const handler = createMcpHandler(({ requestInfo }) => {
  const origin = new URL(
    process.env.RETAINER_DOCS_ORIGIN ?? requestInfo?.url ?? 'http://localhost:3000',
  ).origin;
  // Accept site links as clients see them: absolute, with a trailing slash, or as Markdown.
  const docsPath = (url: string) => {
    const parsed = URL.parse(url, origin);
    return parsed?.origin === origin ? parsed.pathname.replace(/\/$/, '') : undefined;
  };

  const server = new McpServer(
    { name: 'retainer-docs', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: 'Search and read the public Retainer product documentation.',
    },
  );
  registerSourceTools(
    server,
    {
      ...source,
      getPageByUrl(url, language) {
        const path = docsPath(url);
        return path ? source.getPageByUrl(path, language) : undefined;
      },
    },
    {
      ...docsLlms,
      async serve(url, language) {
        const path = docsPath(url);
        if (!path) return undefined;
        const unprefixed = path.startsWith(`${markdownPrefix}/`)
          ? path.slice(markdownPrefix.length)
          : path;
        return docsLlms.serve(unprefixed, language);
      },
    },
  );
  registerSearchTool(server, docsSearch);
  return server;
});

// Next passes route context as a second argument, which handler.fetch would read as options.
const serve = (request: Request) => handler.fetch(request);

export { serve as DELETE, serve as GET, serve as POST };
