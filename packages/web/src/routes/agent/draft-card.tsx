import type { ReactNode } from 'react';

export function DraftCard({
  children,
  actions,
  notice,
}: {
  children: ReactNode;
  actions?: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:p-4">
      {children}
      {notice}
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
