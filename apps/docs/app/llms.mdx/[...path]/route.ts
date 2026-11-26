import { docsLlms, serveLlms } from '@/lib/llms';

export const dynamic = 'force-static';
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await docsLlms.files())
    .filter((file) => file !== '/llms.txt' && file !== '/llms-full.txt')
    .map((file) => ({ path: decodeURI(file).slice(1).split('/') }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return serveLlms(`/${(await params).path.join('/')}`);
}
