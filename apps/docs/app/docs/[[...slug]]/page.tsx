import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/notebook/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OpenAPIPage } from '@/components/api-page';
import { PageActions } from '@/components/page-actions';
import { operationLabel, pageImage, siteName } from '@/lib/doc-page';
import { repository } from '@/lib/guide-links';
import { markdownUrl } from '@/lib/llms';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';

type Props = { params: Promise<{ slug?: string[] }> };

async function getPage(params: Props['params']) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return page;
}

export default async function Page({ params }: Props) {
  const page = await getPage(params);
  const markdown = markdownUrl(page);
  const github =
    page.type === 'docs' ? `${repository}/blob/main/docs/${page.data.info.path}` : undefined;

  return (
    <DocsPage toc={page.type === 'docs' ? page.data.toc : undefined} full={page.type === 'openapi'}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.type === 'docs' && <DocsDescription>{page.data.description}</DocsDescription>}
      <PageActions pathname={`${page.url}/`} markdownUrl={markdown} githubUrl={github} />
      {page.type === 'openapi' ? (
        <OpenAPIPage {...page.data.getOpenAPIPageProps()} />
      ) : (
        <DocsBody>
          <page.data.body components={getMDXComponents()} />
        </DocsBody>
      )}
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getPage(params);
  const image = pageImage(page.slugs);
  const description = operationLabel(page) ?? page.data.description;
  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description,
      siteName,
      images: [{ url: image.url, width: 1200, height: 630, alt: page.data.title }],
    },
    twitter: { card: 'summary_large_image' },
    alternates: { types: { 'text/markdown': markdownUrl(page) } },
  };
}
