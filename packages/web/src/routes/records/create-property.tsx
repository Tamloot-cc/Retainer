import type { FieldView } from '@retainer/shared';
import { ChevronDown } from 'lucide-react';
import { type Ref, useId } from 'react';
import { dateText, type InputProps } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import { cn } from '../../ui/core.js';
import { ApiName, Button } from '../../ui/index.js';

export function hasPropertyPicker(field: FieldView) {
  return field.type === 'select' || field.type === 'multi_select' || field.type === 'relation';
}

function valueLabel(field: FieldView, value: unknown) {
  if (fields[field.type].isEmpty(value)) return '';
  if (field.type === 'date' || field.type === 'date_time')
    return dateText(String(value), field.type === 'date_time');
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'text' || field.type === 'number') return String(value);
  if (field.type === 'files' && Array.isArray(value)) return String(value.length);
  return 'Set';
}

export function CreateProperty({
  field,
  value,
  onChange,
  editorId,
  expanded,
  onToggle,
  apiName,
  error,
  ref,
}: InputProps & {
  editorId: string;
  expanded: boolean;
  onToggle: () => void;
  apiName?: string;
  error?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const { icon: Icon, Input } = fields[field.type];
  const errorId = useId();
  const picker = hasPropertyPicker(field);
  const icon = <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />;
  const className = cn(
    'h-8 max-w-full rounded-lg border-border bg-muted/45 px-2.5 text-sm font-medium hover:bg-hover pointer-coarse:min-h-11',
    error && 'border-destructive/60',
  );
  const label = picker ? '' : valueLabel(field, value);
  return (
    <div ref={ref} className="flex min-w-0 max-w-full flex-col items-start gap-1">
      {picker ? (
        <Input
          field={field}
          value={value}
          onChange={onChange}
          compactTrigger={{ className, triggerIcon: icon }}
          controlState={{
            'aria-invalid': !!error,
            'aria-describedby': error ? errorId : undefined,
          }}
        />
      ) : (
        <Button
          aria-label={label ? `${field.label} ${label}` : field.label}
          aria-expanded={expanded}
          aria-controls={editorId}
          aria-invalid={error ? true : undefined}
          onClick={onToggle}
          className={cn(className, 'min-w-0 justify-start', expanded && 'bg-hover')}
        >
          {icon}
          <span className="min-w-0 truncate text-muted-foreground">{field.label}</span>
          {label ? <span className="min-w-0 truncate">{label}</span> : null}
          <ChevronDown size={13} aria-hidden className="text-muted-foreground" />
        </Button>
      )}
      {apiName ? <ApiName>{apiName}</ApiName> : null}
      {error && picker ? (
        <span id={errorId} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
