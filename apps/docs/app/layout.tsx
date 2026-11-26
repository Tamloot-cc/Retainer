import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import { siteName } from '@/lib/doc-page';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.RETAINER_DOCS_ORIGIN ?? 'http://localhost:3000'),
  title: {
    default: siteName,
    template: `%s | ${siteName}`,
  },
  description: 'Documentation for Retainer, open-source memory for AI agents.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
