import { createFromSource } from 'fumadocs-core/search/server';
import { operationLabel } from './doc-page';
import { source } from './source';

export const docsSearch = createFromSource(source, {
  language: 'english',
  // Search results keep their relevance order, so skip the sort index it would ship.
  sort: { enabled: false },
  buildIndex(page) {
    const operation = operationLabel(page);
    const title = page.data.title ?? 'Retainer documentation';
    // The tokenizer keeps "self-host" whole, so match the common unhyphenated query too.
    const alias = page.url === '/docs/self-hosted' ? 'Self host Retainer with Docker Compose.' : '';
    return {
      title: operation ? `${operation} · ${title}` : title,
      description: [alias, page.data.description].filter(Boolean).join(' '),
      url: page.url,
      id: page.url,
      tag: page.slugs[0] === 'mcp' ? 'mcp' : page.slugs[0] === 'api' ? 'api' : 'guides',
      structuredData: page.data.structuredData,
    };
  },
});
