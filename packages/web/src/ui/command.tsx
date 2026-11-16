import * as Dialog from '@radix-ui/react-dialog';
import { Command as Primitive } from 'cmdk';
import type { ComponentProps, ReactNode } from 'react';

/** cmdk interaction with Retainer's Radix modal and visual tokens. */
export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-xs" />
        <Dialog.Content
          className="fixed left-1/2 top-[min(12dvh,8rem)] z-50 w-[min(94vw,40rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export const Command = Primitive;
export const CommandInput = Primitive.Input;
export function CommandList(props: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      {...props}
      className="h-[min(calc(var(--cmdk-list-height,14rem)+1rem),26rem,55dvh)] min-h-[min(14rem,40dvh)] overflow-y-auto overscroll-contain p-2 scroll-py-2 transition-[height] duration-150 motion-reduce:transition-none"
    />
  );
}
export function CommandGroup(props: ComponentProps<typeof Primitive.Group>) {
  return (
    <Primitive.Group
      {...props}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
    />
  );
}
export function CommandItem(props: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      {...props}
      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-selection data-[selected=true]:text-selection-foreground [&_svg]:shrink-0"
    />
  );
}
