import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateOGImage } from 'fumadocs-ui/og';
import { operationLabel, pageImage, siteName } from '@/lib/doc-page';
import { source } from '@/lib/source';

export const dynamic = 'force-static';
export const dynamicParams = false;

const icon = readFile(join(process.cwd(), 'app/icon.svg'), 'base64');

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: pageImage(page.slugs).segments }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const page = source.getPage((await params).slug.slice(0, -1));
  if (!page) return new Response(null, { status: 404 });

  return generateOGImage({
    site: siteName,
    title: page.data.title ?? 'Retainer documentation',
    description: operationLabel(page) ?? page.data.description,
    primaryColor: '#d4fa38',
    primaryTextColor: '#d4fa38',
    icon: (
      // biome-ignore lint/performance/noImgElement: rendered to PNG by Satori, not the browser
      <img alt="" width={64} height={64} src={`data:image/svg+xml;base64,${await icon}`} />
    ),
  });
}
