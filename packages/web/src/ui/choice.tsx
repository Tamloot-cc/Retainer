import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from 'react';
import { cn } from './core.js';

type Kind = 'checkbox' | 'radio' | 'switch';

type ChoiceProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'role' | 'className' | 'children'
> & {
  ref?: Ref<HTMLInputElement>;
  /** What the control turns on. Without one the control stands alone and needs an `aria-label`. */
  label?: ReactNode;
  /** Muted lines under the label; read out as the control's description, not its name. */
  description?: ReactNode;
  /**
   * `plain` sits in running text or a menu; `card` is a grey panel for settings and consents;
   * `option` is a bordered choice that is highlighted while chosen.
   */
  variant?: 'plain' | 'card' | 'option';
  /** Cut the label to one line, for menus. */
  truncate?: boolean;
};

const VARIANT = {
  plain: 'gap-2',
  card: 'min-h-11 gap-2.5 rounded-md bg-muted/50 px-3 py-2.5',
  option:
    'cursor-pointer gap-3 rounded-md border border-border bg-background p-3 has-[:checked]:border-primary',
};

/**
 * The one way to draw a checkbox, radio or switch. The whole row is the touch target, and the
 * control's own margin in `style.css` centres it on the label's first line at any text size.
 */
function Choice({
  kind,
  label,
  description,
  variant = 'plain',
  truncate = false,
  ...input
}: ChoiceProps & { kind: Kind }) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const named = label !== undefined && input['aria-label'] === undefined;
  const describedBy = [description ? descriptionId : undefined, input['aria-describedby']]
    .filter(Boolean)
    .join(' ');
  const control = (
    <input
      {...input}
      type={kind === 'radio' ? 'radio' : 'checkbox'}
      role={kind === 'switch' ? 'switch' : undefined}
      aria-labelledby={named ? labelId : input['aria-labelledby']}
      aria-describedby={describedBy || undefined}
      className={`ui-${kind}`}
    />
  );
  if (label === undefined) return control;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the first child.
    <label
      className={cn('flex min-w-0 items-start text-sm', truncate && 'flex-1', VARIANT[variant])}
    >
      {control}
      <span className="flex min-w-0 flex-col gap-1">
        <span
          id={labelId}
          className={cn(
            truncate ? 'truncate' : '[overflow-wrap:anywhere]',
            description && 'font-medium',
          )}
        >
          {label}
        </span>
        {description ? (
          <span
            id={descriptionId}
            className="flex flex-col gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]"
          >
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Checkbox(props: ChoiceProps) {
  return <Choice kind="checkbox" {...props} />;
}

export function Radio(props: ChoiceProps) {
  return <Choice kind="radio" {...props} />;
}

export function Switch(props: ChoiceProps) {
  return <Choice kind="switch" {...props} />;
}
