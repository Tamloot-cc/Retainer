import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from './core.js';

/**
 * Markdown text, laid out for reading inside the app. Each block follows its
 * own direction (`dir="auto"`); code stays left to right. Links open in a new
 * tab, since what they point to is outside the app.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      dir="auto"
      className={cn(
        'whitespace-normal [&_p]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-6 [&_ol]:ps-6 [&_a]:underline [&_pre]:overflow-auto [&_pre]:text-left',
        className,
      )}
      style={{ textAlign: 'start' }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _, ...props }) => <p {...props} dir="auto" />,
          li: ({ node: _, ...props }) => <li {...props} dir="auto" />,
          h1: ({ node: _, ...props }) => <h1 {...props} dir="auto" />,
          h2: ({ node: _, ...props }) => <h2 {...props} dir="auto" />,
          h3: ({ node: _, ...props }) => <h3 {...props} dir="auto" />,
          h4: ({ node: _, ...props }) => <h4 {...props} dir="auto" />,
          h5: ({ node: _, ...props }) => <h5 {...props} dir="auto" />,
          h6: ({ node: _, ...props }) => <h6 {...props} dir="auto" />,
          blockquote: ({ node: _, ...props }) => <blockquote {...props} dir="auto" />,
          th: ({ node: _, ...props }) => <th {...props} dir="auto" />,
          td: ({ node: _, ...props }) => <td {...props} dir="auto" />,
          pre: ({ node: _, ...props }) => <pre {...props} dir="ltr" />,
          a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
