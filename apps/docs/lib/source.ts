import { loader } from 'fumadocs-core/source';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { docs } from '@/.source/server';
import { guideSlugs } from './guides';
import { contract } from './rest-contract';

// API pages load the document once per browser session (see components/api-page.tsx)
// instead of carrying a copy of it in every page.
export const openapi = createOpenAPI({ input: { retainer: contract }, includeDocument: false });

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({ baseDir: 'api', groupBy: 'tag' }),
  },
  {
    baseUrl: '/docs',
    plugins: [openapi.loaderPlugin()],
    slugs: (file) => guideSlugs.get(file.path.replace(/\.mdx?$/, '')),
  },
);
