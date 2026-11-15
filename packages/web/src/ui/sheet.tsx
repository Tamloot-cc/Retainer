import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { Button } from './index.js';

/**
 * A panel that slides in from the right edge over the page, for a record
 * opened from a list. Render it to open it. It is non-modal: the page
 * behind stays usable, so opening another row swaps the content without
 * closing the sheet first. The close button and Escape call `onClose`;
 * layers inside it (an inline editor, a dialog) get Escape first.
 */
export function Sheet({
  onClose,
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  onClose: () => void;
  eyebrow?: string;
  /** Read by assistive technology as the sheet's name; shown as the heading. */
  title: string;
  /** Read by assistive technology only. */
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={panel}
          onOpenAutoFocus={(e) => {
            // Focus the panel itself rather than its first control.
            e.preventDefault();
            panel.current?.focus();
          }}
          // Clicking the list behind opens another record; it must not close the sheet.
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-[-6px_0_20px_rgb(0_0_0/0.06)] outline-none sm:w-[min(38rem,92vw)] motion-safe:animate-sheet-in"
        >
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
            <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground first-letter:uppercase">
              {eyebrow}
            </div>
            {actions}
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close" title="Close (Esc)">
                <X size={16} />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [--sticky-top:0px] [scrollbar-gutter:stable]">
            <div className="flex flex-col gap-6 px-5 py-5">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {description}
              </DialogPrimitive.Description>
              {children}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
