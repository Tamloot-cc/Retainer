import type { LucideIcon } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import {
  ReviewCard,
  ReviewCardBody,
  ReviewCardFooter,
  ReviewCardHeader,
  ReviewIcon,
} from '../../ui/review.js';

/** The same card anatomy used in the workspace review inbox. */
export function ExtensionCard({
  title,
  icon,
  children,
  actions,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <ReviewCard>
      <ReviewCardHeader title={title} leading={<ReviewIcon icon={icon} />} />
      <ReviewCardBody>{children}</ReviewCardBody>
      {actions ? <ReviewCardFooter>{actions}</ReviewCardFooter> : null}
    </ReviewCard>
  );
}

export function ExtensionFacts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0 space-y-1 rounded-md bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A checkbox and its explanation share one touch target. */
export function ExtensionCheckbox({
  children,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-11 min-w-0 items-start gap-2.5 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
      <input {...input} type="checkbox" className="ui-checkbox" />
      <span className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">{children}</span>
    </label>
  );
}
