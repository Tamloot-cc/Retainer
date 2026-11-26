import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const withMDX = createMDX();

export default (phase) => {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const server = dev || process.env.RETAINER_DOCS_RUNTIME === 'server';

  return withMDX({
    ...(server ? { distDir: dev ? '.next' : '.next-server' } : { output: 'export' }),
    // The live MCP handler (route.server.ts) is only included when Next serves HTTP requests.
    pageExtensions: ['ts', 'tsx', ...(server ? ['server.ts'] : [])],
    agentRules: false,
    trailingSlash: true,
    turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  });
};
