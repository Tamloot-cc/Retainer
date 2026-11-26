'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import DocsSearch from './search';

export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog: DocsSearch }}>{children}</RootProvider>;
}
