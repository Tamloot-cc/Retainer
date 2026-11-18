import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, type LucideIcon, Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { cn, PANEL, PLACEMENT } from './core.js';

export type PickerOption = {
  value: string;
  /** Plain text: the option's accessible name and what search matches. */
  label: string;
  /** Shown in place of `label`, e.g. as a badge. */
  content?: ReactNode;
  /** More words that search matches, e.g. a currency's full name. */
  keywords?: string;
  /** Muted text at the end of the row, e.g. "Israeli New Shekel". */
  hint?: string;
  /** Listed only while the search box is empty, e.g. "No company". */
  unsearched?: boolean;
};

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Options whose label or keywords contain every word of `search`. */
export function filterOptions(options: PickerOption[], search: string): PickerOption[] {
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = fold(`${o.label} ${o.keywords ?? ''}`);
    return words.every((w) => text.includes(w));
  });
}

/** `values` with `value` added, or taken out if it was there. */
export const toggleValue = (values: readonly string[], value: string) =>
  values.includes(value) ? values.filter((v) => v !== value) : [...values, value];

/** The square a multiple-choice option shows; the option itself carries the state. */
function CheckSquare({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card',
      )}
    >
      {checked ? <Check size={12} strokeWidth={3.5} /> : null}
    </span>
  );
}

/**
 * A searchable list to choose from: a search box on top (a combobox) and the
 * options under it (a listbox). Arrow keys move the highlight and Enter picks
 * the highlighted option; with nothing highlighted, Enter is left to the
 * enclosing form. With `multiple`, picking toggles and the list stays.
 *
 * Search filters `options` here unless `onSearchChange` is given, in which
 * case the caller fetches matching options itself, and says it is still
 * `searching` until `options` match the latest search; until then nothing is
 * highlighted and Enter picks nothing, so it can't choose a stale result.
 */
export function OptionList({
  label,
  options,
  selected = [],
  onPick,
  multiple = false,
  searchable = true,
  placeholder = 'Search…',
  empty = 'No matches',
  status,
  onSearchChange,
  searching = false,
}: {
  /** Names the search box, or the list when there is no search box. */
  label: string;
  options: PickerOption[];
  selected?: readonly string[];
  onPick: (value: string) => void;
  multiple?: boolean;
  searchable?: boolean;
  placeholder?: string;
  /** Shown when no option matches. */
  empty?: string;
  /** A loading or error line under the options. */
  status?: ReactNode;
  onSearchChange?: (search: string) => void;
  /** Remote search only: `options` are still from an earlier search. */
  searching?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(searchable ? -1 : 0);
  const shown = useMemo(() => {
    // Typing looks for a match, so Enter picks a match, never "No company".
    const listed = search.trim() ? options.filter((o) => !o.unsearched) : options;
    return onSearchChange ? listed : filterOptions(listed, search);
  }, [options, search, onSearchChange]);
  const current = searching ? -1 : active < shown.length ? active : shown.length - 1;
  const activeId = current >= 0 ? `${id}-${current}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function changeSearch(next: string) {
    setSearch(next);
    setActive(next.trim() ? 0 : -1);
    onSearchChange?.(next);
  }
  function pick(option: PickerOption) {
    onPick(option.value);
    // After typing to find one option, clear the search to look for the next.
    if (multiple && search) changeSearch('');
  }
  function onKeyDown(e: KeyboardEvent) {
    const last = shown.length - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(current + 1, last));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(current <= 0 ? (searchable ? -1 : 0) : current - 1);
    } else if (!searchable && e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (!searchable && e.key === 'End') {
      e.preventDefault();
      setActive(last);
    } else if (
      (e.key === 'Enter' || (!searchable && e.key === ' ')) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.nativeEvent.isComposing
    ) {
      // Results for the typed search haven't arrived: wait, rather than save.
      if (searching) return e.preventDefault();
      const option = shown[current];
      if (!option) return;
      e.preventDefault();
      pick(option);
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      {searchable ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <Search size={14} aria-hidden className="shrink-0 text-muted-foreground" />
          <input
            role="combobox"
            aria-label={label}
            aria-expanded
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={search}
            placeholder={placeholder}
            onChange={(e) => changeSearch(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : null}
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={searchable ? `${label} options` : label}
        aria-multiselectable={multiple || undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        tabIndex={searchable ? -1 : 0}
        onKeyDown={searchable ? undefined : onKeyDown}
        className="flex max-h-64 min-h-0 flex-col overflow-y-auto overscroll-contain p-1 outline-none"
      >
        {shown.map((option, i) => {
          const isSelected = selected.includes(option.value);
          return (
            // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: focus stays in the search box (or the list), which points at the highlighted option with aria-activedescendant and handles the keys.
            <div
              key={option.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={isSelected}
              data-active={i === current || undefined}
              onPointerMove={() => {
                if (i !== current) setActive(i);
              }}
              // Keep focus in the search box.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(option)}
              className="flex min-h-8 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-sm data-active:bg-hover"
            >
              {multiple ? <CheckSquare checked={isSelected} /> : null}
              <span className="flex min-w-0 flex-1 items-center truncate">
                {option.content ?? option.label}
              </span>
              {option.hint ? (
                <span aria-hidden className="shrink-0 truncate text-xs text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
              {!multiple && isSelected ? (
                <Check size={14} aria-hidden className="shrink-0 text-primary" />
              ) : null}
            </div>
          );
        })}
        {!shown.length && !status ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{empty}</div>
        ) : null}
        {status ? <div className="px-2 py-1.5 text-sm text-muted-foreground">{status}</div> : null}
      </div>
    </div>
  );
}

type SelectMenuProps = {
  /** Names the control; its current value is read after it. */
  label: string;
  options: PickerOption[];
  className?: string;
  placeholder?: string;
  /** Show a search box; by default when there are more than seven options. */
  searchable?: boolean;
  /** Fill the width of the container, as form inputs do. */
  fill?: boolean;
  size?: 'default' | 'small';
  status?: ReactNode;
  onSearchChange?: (search: string) => void;
  /** Remote search only: `options` are still from an earlier search. */
  searching?: boolean;
  /** Told when the list opens and closes, e.g. to fetch options only while open. */
  onOpenChange?: (open: boolean) => void;
  /** Shown on the button when the value isn't among `options`. */
  fallback?: ReactNode;
} & (
  | { multiple?: false; value: string | null; onChange: (value: string) => void }
  | { multiple: true; value: readonly string[]; onChange: (value: string[]) => void }
);

/**
 * A button that shows the current choice and opens an `OptionList` to change
 * it. Replaces the native `<select>` everywhere. A single choice closes the
 * list; a multiple one stays open to pick more.
 */
export function SelectMenu(props: SelectMenuProps) {
  const {
    label,
    options,
    className,
    placeholder = 'Choose…',
    fill = false,
    size = 'default',
    status,
    onSearchChange,
    searching,
    onOpenChange,
    fallback,
  } = props;
  const id = useId();
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const selected = props.multiple ? props.value : props.value === null ? [] : [props.value];
  const searchable = props.searchable ?? (options.length > 7 || !!onSearchChange);
  const chosen = selected
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is PickerOption => !!o);
  const shown = chosen.length ? (
    <span className="flex min-w-0 items-center gap-1 truncate">
      {chosen.map((o) => (
        <span key={o.value} className="flex min-w-0 shrink-0 items-center">
          {o.content ?? o.label}
        </span>
      ))}
    </span>
  ) : selected.length && fallback ? (
    fallback
  ) : (
    <span className="text-muted-foreground">{placeholder}</span>
  );
  function pick(value: string) {
    if (props.multiple) {
      props.onChange(toggleValue(props.value, value));
    } else {
      props.onChange(value);
      setOpen(false);
    }
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      {/* Outside the button, so its text is only the value. */}
      <span id={`${id}-label`} hidden>
        {label}
      </span>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-labelledby={`${id}-label ${id}-value`}
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-input bg-background text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring',
            size === 'small' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-sm',
            fill && 'w-full',
            className,
          )}
        >
          <span id={`${id}-value`} className="flex min-w-0 flex-1 items-center truncate">
            {shown}
          </span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align="start"
          {...PLACEMENT}
          className={cn(
            PANEL,
            'flex max-h-[min(var(--radix-popover-content-available-height),24rem)] w-[max(var(--radix-popover-trigger-width),14rem)] max-w-[92vw] flex-col overflow-hidden',
          )}
        >
          <OptionList
            label={searchable ? `Search ${label.toLowerCase()}` : label}
            options={options}
            selected={selected}
            multiple={props.multiple}
            searchable={searchable}
            status={status}
            onSearchChange={onSearchChange}
            searching={searching}
            onPick={pick}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A name with its type's icon in front, e.g. a field in a list of fields. */
export function IconLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Two or three choices side by side, one of them pressed. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset aria-label={label} className="m-0 flex min-w-0 rounded-md border-0 bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className="flex h-6 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm [&_svg]:shrink-0"
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
