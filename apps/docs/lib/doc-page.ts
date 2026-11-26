import type { source } from './source';

export const siteName = 'Retainer Docs';

export type DocPage = typeof source.$inferPage;

export function operationLabel(page: DocPage) {
  if (page.type !== 'openapi') return undefined;
  const operation = page.data.getOpenAPIPageProps().operations?.[0];
  return operation && `${operation.method.toUpperCase()} ${operation.path}`;
}

export function pageImage(slugs: string[]) {
  const segments = [...slugs, 'image.png'];
  return { segments, url: `/og/docs/${segments.map(encodeURIComponent).join('/')}` };
}
