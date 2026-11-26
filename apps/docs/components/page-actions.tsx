'use client';

import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/notebook/page';

export function PageActions({
  pathname,
  markdownUrl,
  githubUrl,
}: {
  pathname: string;
  markdownUrl: string;
  githubUrl?: string;
}) {
  // The router can render the next page before window.location has its new path.
  const pageUrl =
    typeof window === 'undefined' ? pathname : new URL(pathname, window.location.origin).href;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MarkdownCopyButton markdownUrl={markdownUrl} />
      <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} pageUrl={pageUrl} />
    </div>
  );
}
