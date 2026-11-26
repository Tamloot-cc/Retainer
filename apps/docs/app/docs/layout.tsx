import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { siteName } from '@/lib/doc-page';
import { repository } from '@/lib/guide-links';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      tabMode="navbar"
      nav={{
        url: '/docs/',
        mode: 'top',
        title: (
          <span className="flex items-center gap-2">
            <Image src="/icon.svg" alt="" width={24} height={24} unoptimized />
            {siteName}
          </span>
        ),
      }}
      githubUrl={repository}
      links={[
        { text: 'Open Retainer', url: 'https://retainer.tamloot.cc/app/', external: true },
        {
          type: 'menu',
          text: 'Resources',
          items: [
            { text: 'Releases', url: `${repository}/releases`, external: true },
            { text: 'OpenAPI specification', url: '/openapi.json', external: true },
            { text: 'Markdown index', url: '/llms.txt', external: true },
            { text: 'Docs MCP', url: '/docs/mcp/docs-server/' },
          ],
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
