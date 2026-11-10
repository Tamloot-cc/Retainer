import type {
  AddressValue,
  EmailsValue,
  FieldView,
  FullNameValue,
  LinksValue,
  MoneyValue,
  ObjectView,
  PhonesValue,
  PresentedRecord,
  RecordReference,
} from '@retainer/shared';
import {
  isCollectionRelation,
  isPolymorphic,
  normalizeFieldValue,
  relationTargets,
} from '@retainer/shared';
import { useQueries } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Plus, Star, X } from 'lucide-react';
import { type ComponentType, type ContextType, type ReactNode, useContext, useState } from 'react';
import { api, useWorkspace, WorkspaceContext } from '../api/client.js';
import { objectByName, objectLabel, recordTitle, useDebounced } from '../routes/state.js';
import {
  Badge,
  Button,
  Check,
  CheckLabel,
  Columns,
  ExternalLink,
  type FitItem,
  FitList,
  Fixed,
  Input,
  Label,
  Muted,
  OptionList,
  type PickerOption,
  RecordLink,
  Row,
  SelectMenu,
  Stack,
  Textarea,
  Tooltip,
  toggleValue,
} from '../ui/index.js';
export type DisplayProps = {
  field: FieldView;
  value: unknown;
  compact?: boolean;
  references?: Record<string, RecordReference>;
};
export type InputProps = {
  field: FieldView;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Labels for relation IDs the value already holds. */
  references?: Record<string, RecordReference>;
};
export type FieldModule = {
  /** The type's name where the schema itself is shown, e.g. "Single select". */
  label: string;
  icon: LucideIcon;
  Display: ComponentType<DisplayProps>;
  /** The value as a form control, for create forms and filters. */
  Input: ComponentType<InputProps>;
  Filter: ComponentType<InputProps & { operator: string }>;
  isEmpty: (value: unknown) => boolean;
};
/**
 * Types edited in place by choosing from a list (`FieldPicker`) rather than in
 * a form: `one` saves on the pick, `many` when the list is left.
 */
export const PICKERS: Partial<Record<FieldView['type'], 'one' | 'many'>> = {
  select: 'one',
  multi_select: 'many',
  relation: 'one',
  boolean: 'one',
};
/** How a field is picked in place, if it is: a many_to_many relation takes a set. */
export const pickerFor = (field: Pick<FieldView, 'type' | 'settings'>) =>
  isCollectionRelation(field) ? 'many' : PICKERS[field.type];
/** "Company", "Company or Person", "Company, Person or Deal". */
export function joinOr(words: string[]) {
  return words.length > 1
    ? `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
    : (words[0] ?? '');
}
/** The object a polymorphic relation's record belongs to, after its name. */
function ObjectTag({ children }: { children: ReactNode }) {
  // Read as "Acme (Company)"; the parentheses are only for screen readers.
  return (
    <Badge>
      <span className="sr-only">(</span>
      {children}
      <span className="sr-only">)</span>
    </Badge>
  );
}
/** A record's name, with its object when the field links several (`object`). */
function TargetName({ title, object }: { title: ReactNode; object?: string }) {
  return object ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{title}</span> <ObjectTag>{object}</ObjectTag>
    </span>
  ) : (
    title
  );
}
/** A relation value's record IDs: one, a set, or none. */
export const relationIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && !!id)
    : typeof value === 'string' && value
      ? [value]
      : [];
export function isEmptyFor(type: FieldView['type'], value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (type === 'full_name') {
    const v = value as FullNameValue;
    return !v.first && !v.last;
  }
  if (type === 'address')
    return Object.values(value as AddressValue).every((v) => v === undefined || v === '');
  if (type === 'emails' || type === 'phones' || type === 'links') {
    const v = value as { primary: unknown; additional: unknown[] };
    return v.primary === null && !v.additional.length;
  }
  return false;
}
export const dateText = (v: string, time = false) => {
  const d = new Date(time ? v : `${v}T12:00:00`);
  return Number.isNaN(d.getTime()) ? v : time ? d.toLocaleString() : d.toLocaleDateString();
};
/** "$1,200.50"; an unknown currency code falls back to "1200.5 XYZ". */
export function moneyText(v: MoneyValue): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: v.currency,
      maximumFractionDigits: 6,
    }).format(v.amountMicros / 1e6);
  } catch {
    return `${v.amountMicros / 1e6} ${v.currency}`;
  }
}
export function FieldDisplay({ field, value, compact = false, references = {} }: DisplayProps) {
  if (isEmptyFor(field.type, value)) return <Muted>—</Muted>;
  switch (field.type) {
    case 'text':
      return (
        <Tooltip content={String(value)}>
          {/* Compact hosts outside the grid (the merge table) don't truncate. */}
          <span>
            {compact && String(value).length > 60
              ? `${String(value).slice(0, 60)}…`
              : String(value)}
          </span>
        </Tooltip>
      );
    case 'number':
      return <span>{Number(value).toLocaleString()}</span>;
    case 'boolean':
      return <Check value={!!value} />;
    case 'date':
    case 'date_time':
      return (
        <Tooltip content={String(value)}>
          <span>{dateText(String(value), field.type === 'date_time')}</span>
        </Tooltip>
      );
    case 'select':
      return (
        <Badge>
          {field.settings.options?.find((o) => o.value === value)?.label ?? String(value)}
        </Badge>
      );
    case 'multi_select': {
      // Each key carries what the item shows, so a changed label is measured again.
      const badges = (value as string[]).map((v) => {
        const label = field.settings.options?.find((o) => o.value === v)?.label ?? v;
        return {
          key: `${v}\u0000${label}`,
          node: (
            <Badge>
              <span className="truncate">{label}</span>
            </Badge>
          ),
        };
      });
      return <ListDisplay items={badges} compact={compact} />;
    }
    case 'money':
      return <span>{moneyText(value as MoneyValue)}</span>;
    case 'full_name': {
      const v = value as FullNameValue;
      return (
        <span>
          {v.first} {v.last}
        </span>
      );
    }
    case 'address': {
      const v = value as AddressValue;
      return (
        <span>
          {(compact
            ? [v.city, v.country]
            : [
                v.street1,
                v.street2,
                v.city,
                v.state,
                v.postcode,
                v.country,
                v.lat !== undefined ? `${v.lat}, ${v.lng}` : undefined,
              ]
          )
            .filter(Boolean)
            .join(', ') || '—'}
        </span>
      );
    }
    case 'relation':
      return (
        <RelationDisplay field={field} value={value} compact={compact} references={references} />
      );
    case 'json':
      return compact ? (
        <Tooltip content={JSON.stringify(value, null, 2)}>
          <span>{JSON.stringify(value).slice(0, 60)}</span>
        </Tooltip>
      ) : (
        <Textarea
          aria-label={`${field.label} JSON`}
          readOnly
          value={JSON.stringify(value, null, 2)}
        />
      );
    case 'emails':
    case 'phones':
    case 'links': {
      const v = value as EmailsValue | PhonesValue | LinksValue;
      const items = [v.primary, ...v.additional]
        .filter((item): item is NonNullable<typeof item> => !!item)
        .map((item): FitItem => {
          if (typeof item === 'string')
            return { key: item, node: <span className="truncate">{item}</span> };
          if ('url' in item) {
            const label = item.label || new URL(item.url).host;
            return {
              key: `${item.url}\u0000${label}`,
              node: (
                <ExternalLink href={item.url}>
                  <span className="truncate">{label}</span>
                </ExternalLink>
              ),
            };
          }
          return {
            key: `${item.countryCode ?? ''}${item.number}`,
            node: (
              <span className="truncate">
                {item.number}
                {item.countryCode ? ` (${item.countryCode})` : ''}
              </span>
            ),
          };
        });
      if (items.length === 0) return <Muted>—</Muted>;
      return <ListDisplay items={items} compact={compact} />;
    }
  }
}
/**
 * A list of values: in a list cell, as many as the column has room for and
 * how many more there are; on the record page, all of them.
 */
function ListDisplay({ items, compact }: { items: FitItem[]; compact?: boolean }) {
  if (compact) return <FitList items={items} />;
  return (
    <Row>
      {items.map((item) => (
        <span key={item.key} className="flex min-w-0">
          {item.node}
        </span>
      ))}
    </Row>
  );
}
/**
 * Linked records by name. A polymorphic relation tags each with its object,
 * so "Acme (Company)" and "Acme (Person)" can be told apart.
 */
function RelationDisplay({ field, value, compact, references = {} }: DisplayProps) {
  const workspace = useContext(WorkspaceContext);
  return (
    <ListDisplay items={relationItems(field, value, references, workspace)} compact={compact} />
  );
}
/** Each linked record as a list item: its name as a link, tagged with its object if need be. */
export function relationItems(
  field: FieldView,
  value: unknown,
  references: Record<string, RecordReference>,
  workspace: ContextType<typeof WorkspaceContext>,
): FitItem[] {
  const tagged = isPolymorphic(field);
  return relationIds(value).map((id) => {
    const reference = references[id];
    if (!reference) return { key: id, node: <Muted>Unavailable reference</Muted> };
    const name = recordTitle(reference);
    const object = workspace ? objectLabel(workspace.schema, reference.object) : reference.object;
    return {
      key: `${id}\u0000${name}\u0000${tagged ? object : ''}`,
      node: tagged ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <RecordLink id={id}>{name}</RecordLink> <ObjectTag>{object}</ObjectTag>
        </span>
      ) : (
        <RecordLink id={id}>{name}</RecordLink>
      ),
    };
  });
}

/** Exact decimal-to-micros conversion; never multiply a floating-point input. */
export function decimalToMicros(raw: string): number {
  if (!/^-?\d+(\.\d{0,6})?$/.test(raw))
    throw new Error('Use a decimal amount with at most 6 fractional digits');
  const negative = raw.startsWith('-');
  const [whole = '', fraction = ''] = raw.replace(/^-/, '').split('.');
  const n = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const signed = negative ? -n : n;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error('Amount is too large');
  return Number(signed);
}
export function microsToDecimal(n: number): string {
  const sign = n < 0 ? '-' : '';
  const v = BigInt(Math.abs(n));
  return (
    `${sign}${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, '0')}`.replace(/\.?0+$/, '') ||
    '0'
  );
}

/** A select field's options, each shown as the badge the grid shows. */
export function selectOptions(field: FieldView): PickerOption[] {
  return (field.settings.options ?? []).map((o) => ({
    value: o.value,
    label: o.label,
    content: <Badge>{o.label}</Badge>,
  }));
}
/**
 * The choice that clears a field, "No stage" (its value is the empty string),
 * as a list of one when `show` (by default, when the field may be empty).
 */
function clearOption(field: FieldView, show = field.isNullable): PickerOption[] {
  const label = `No ${field.label.toLowerCase()}`;
  return show ? [{ value: '', label, content: <Muted>{label}</Muted>, unsearched: true }] : [];
}
/** A select field's options in a menu: one choice, or several. */
function OptionsMenu({
  field,
  value,
  onChange,
  multiple = false,
  clearable = false,
}: InputProps & { multiple?: boolean; clearable?: boolean }) {
  return multiple ? (
    <SelectMenu
      label={field.label}
      fill
      multiple
      placeholder="Choose options"
      options={selectOptions(field)}
      value={Array.isArray(value) ? (value as string[]) : []}
      onChange={onChange}
    />
  ) : (
    <SelectMenu
      label={field.label}
      fill
      placeholder="Choose an option"
      options={[...clearOption(field, clearable && !!value), ...selectOptions(field)]}
      value={typeof value === 'string' && value ? value : null}
      onChange={(v) => onChange(v || null)}
    />
  );
}
const BOOLEAN_OPTIONS: PickerOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

let currencies: PickerOption[] | undefined;
/** Every ISO currency, searchable by code or name. */
function currencyOptions(current: string): PickerOption[] {
  if (!currencies) {
    const names = new Intl.DisplayNames(undefined, { type: 'currency' });
    currencies = Intl.supportedValuesOf('currency').map((code) => {
      const name = names.of(code);
      return { value: code, label: code, hint: name, keywords: name };
    });
  }
  return currencies.some((c) => c.value === current)
    ? currencies
    : [{ value: current, label: current }, ...currencies];
}

/** Most records a picker lists for one search, shared among a polymorphic relation's objects. */
const PICKER_LIMIT = 50;
/**
 * Lists of records, one per object, merged by taking each list's next record
 * in turn, so every object's best matches come first. Ranks aren't
 * comparable across objects, so this is as fair as a merge gets.
 */
export function interleave<T>(lists: T[][]): T[] {
  const merged: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++)
    for (const list of lists) if (i < list.length) merged.push(list[i] as T);
  return merged;
}
/**
 * A picker option for a record. Where the field links several objects, its
 * object is named after it ("Acme (Company)"), on screen and to search.
 */
function recordOption(title: string, id: string, object?: string): PickerOption {
  return object
    ? {
        value: id,
        label: `${title} (${object})`,
        content: <TargetName title={title} object={object} />,
      }
    : { value: id, label: title };
}

/**
 * Records of a relation's target objects matching a search, as options: one
 * query per allowed object (one, unless the relation is polymorphic), never
 * one per record. The current value (each member of a set) stays listed while
 * nothing is typed, even when the results don't include it. Fetches only
 * while `enabled` (the list is open), once typing pauses.
 */
function useRelationOptions(
  field: FieldView,
  value: unknown,
  references: Record<string, RecordReference> | undefined,
  enabled = true,
) {
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim());
  const targets = relationTargets(field)
    .map((name) => objectByName(workspace.schema, name))
    .filter((o): o is ObjectView => !!o);
  const tagged = isPolymorphic(field);
  const limit = Math.max(10, Math.ceil(PICKER_LIMIT / Math.max(targets.length, 1)));
  const results = useQueries({
    queries: targets.map((target) => ({
      queryKey: [
        workspace.session.workspace.id,
        'relationPicker',
        target.nameSingular,
        query,
        ...(tagged ? [limit] : []),
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.queryRecords(target.nameSingular, { search: query || undefined, limit }, signal),
      enabled,
      placeholderData: <T,>(previous: T) => previous,
    })),
  });
  const objectOf = (name: string | undefined) =>
    tagged && name ? objectLabel(workspace.schema, name) : undefined;
  // Remember records seen, so the chosen one keeps its name.
  const [seen, setSeen] = useState<Record<string, PickerOption>>({});
  const records = interleave(results.map((r) => (r.data?.records ?? []) as PresentedRecord[]));
  const options: PickerOption[] = records.map((r) =>
    recordOption(recordTitle(r), r.id, objectOf(r.object)),
  );
  const current = relationIds(value);
  const optionOf = (id: string): PickerOption => {
    const reference = references?.[id];
    if (reference) return recordOption(recordTitle(reference), id, objectOf(reference.object));
    return seen[id] ?? { value: id, label: 'Current record' };
  };
  const first = current[0] ? optionOf(current[0]) : null;
  const currentLabel = first ? (first.content ?? first.label) : null;
  if (!query)
    options.unshift(...current.filter((id) => !options.some((o) => o.value === id)).map(optionOf));
  const remember = (ids: string | string[]) => {
    const found = options.filter((o) => relationIds(ids).includes(o.value));
    if (found.length)
      setSeen((s) => ({ ...s, ...Object.fromEntries(found.map((o) => [o.value, o])) }));
  };
  const error = results.find((r) => r.error)?.error;
  // The typed search is still settling, or its results are still on the way.
  const searching = search.trim() !== query || results.some((r) => r.isPlaceholderData);
  const status = error
    ? error.message
    : searching || results.some((r) => r.isFetching && !r.data)
      ? 'Searching…'
      : undefined;
  return {
    options,
    status,
    searching,
    setSearch,
    remember,
    currentLabel,
    noun: targets.length ? joinOr(targets.map((t) => t.labelPlural.toLowerCase())) : 'records',
  };
}

/**
 * A field edited by choosing from a list: the list itself, open, for an
 * editor that already sits in a popover or a record's row. `onChange` gets
 * each pick: the new value for one choice, the whole new set for many.
 */
export function FieldPicker(props: InputProps) {
  const { field, value, onChange } = props;
  switch (field.type) {
    case 'select':
      return (
        <OptionList
          label={field.label}
          placeholder={`Search ${field.label.toLowerCase()}…`}
          options={[...clearOption(field), ...selectOptions(field)]}
          selected={[typeof value === 'string' ? value : '']}
          onPick={(v) => onChange(v || null)}
        />
      );
    case 'multi_select': {
      const values = Array.isArray(value) ? (value as string[]) : [];
      return (
        <OptionList
          label={field.label}
          placeholder={`Search ${field.label.toLowerCase()}…`}
          multiple
          options={selectOptions(field)}
          selected={values}
          onPick={(v) => onChange(toggleValue(values, v))}
        />
      );
    }
    case 'boolean':
      return (
        <OptionList
          label={field.label}
          searchable={false}
          options={[...BOOLEAN_OPTIONS, ...clearOption(field)]}
          selected={[value === true ? 'true' : value === false ? 'false' : '']}
          onPick={(v) => onChange(v === '' ? null : v === 'true')}
        />
      );
    case 'relation':
      return <RelationPicker {...props} />;
    default:
      return <FieldInput {...props} />;
  }
}
function RelationPicker({ field, value, onChange, references }: InputProps) {
  const r = useRelationOptions(field, value, references);
  if (isCollectionRelation(field)) {
    const members = relationIds(value);
    return (
      <OptionList
        label={field.label}
        placeholder={`Search ${r.noun}…`}
        multiple
        options={r.options}
        selected={members}
        onSearchChange={r.setSearch}
        searching={r.searching}
        status={r.status}
        empty={`No ${r.noun} found`}
        onPick={(v) => {
          r.remember(v);
          onChange(toggleValue(members, v));
        }}
      />
    );
  }
  return (
    <OptionList
      label={field.label}
      placeholder={`Search ${r.noun}…`}
      options={[...clearOption(field), ...r.options]}
      selected={[typeof value === 'string' ? value : '']}
      onSearchChange={r.setSearch}
      searching={r.searching}
      status={r.status}
      empty={`No ${r.noun} found`}
      onPick={(v) => onChange(v || null)}
    />
  );
}
/**
 * A relation chosen from a menu. `multiple` picks a set of records; it
 * defaults to whether the field holds one, and a filter turns it on to
 * match any of several records.
 */
function RelationInput({
  field,
  value,
  onChange,
  references,
  multiple = isCollectionRelation(field),
}: InputProps & { multiple?: boolean }) {
  const [open, setOpen] = useState(false);
  const r = useRelationOptions(field, value, references, open);
  const openChange = (next: boolean) => {
    setOpen(next);
    // The list's search box starts empty each time; so does the query.
    if (!next) r.setSearch('');
  };
  if (multiple)
    return (
      <SelectMenu
        label={field.label}
        fill
        multiple
        placeholder={`Choose ${field.label.toLowerCase()}`}
        options={r.options}
        value={relationIds(value)}
        onOpenChange={openChange}
        onSearchChange={r.setSearch}
        searching={r.searching}
        status={r.status}
        onChange={(ids) => {
          r.remember(ids);
          onChange(ids);
        }}
      />
    );
  return (
    <SelectMenu
      label={field.label}
      fill
      placeholder={`Choose a ${field.label.toLowerCase()}`}
      options={[...clearOption(field, field.isNullable && !!value), ...r.options]}
      value={typeof value === 'string' ? value : null}
      fallback={r.currentLabel}
      onOpenChange={openChange}
      onSearchChange={r.setSearch}
      searching={r.searching}
      status={r.status}
      onChange={(v) => {
        r.remember(v);
        onChange(v || null);
      }}
    />
  );
}

function MoneyInput({ value, onChange }: InputProps) {
  const v = (value ?? { amountMicros: 0, currency: 'USD' }) as MoneyValue;
  const [amount, setAmount] = useState(microsToDecimal(v.amountMicros));
  const [error, setError] = useState('');
  return (
    <Stack>
      <Columns>
        <Label quiet>
          Amount
          <Input
            aria-invalid={!!error}
            value={amount}
            inputMode="decimal"
            onChange={(e) => {
              setAmount(e.target.value);
              try {
                const amountMicros = decimalToMicros(e.target.value);
                setError('');
                onChange({ ...v, amountMicros });
              } catch (err) {
                setError((err as Error).message);
                onChange({ ...v, amountMicros: Number.NaN });
              }
            }}
          />
        </Label>
        <Label quiet>
          Currency
          <SelectMenu
            label="Currency"
            fill
            value={v.currency}
            options={currencyOptions(v.currency)}
            onChange={(currency) => onChange({ ...v, currency })}
          />
        </Label>
      </Columns>
      {error ? <Muted small>{error}</Muted> : null}
    </Stack>
  );
}

const LIST_NOUN = { emails: 'email', phones: 'phone', links: 'link' } as const;
function ListInput({ field, value, onChange }: InputProps) {
  type Item = string | { number: string; countryCode?: string } | { url: string; label?: string };
  const v = (value ?? { primary: null, additional: [] }) as {
    primary: Item | null;
    additional: Item[];
  };
  const values = [...(v.primary !== null ? [v.primary] : []), ...v.additional];
  const noun = LIST_NOUN[field.type as keyof typeof LIST_NOUN];
  const commit = (items: Item[]) =>
    onChange({ primary: items[0] ?? null, additional: items.slice(1) });
  const edit = (i: number, raw: Item) => commit(values.map((v, n) => (n === i ? raw : v)));
  return (
    <Stack gap="small">
      {values.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Controlled positional list; all values live in the parent editor.
        <Row key={i} nowrap>
          {typeof item === 'string' ? (
            <Input
              aria-label={`Email ${i + 1}`}
              type="email"
              placeholder="name@company.com"
              value={item}
              onChange={(e) => edit(i, e.target.value)}
            />
          ) : 'number' in item ? (
            <>
              <Input
                aria-label={`Phone ${i + 1}`}
                type="tel"
                placeholder="+1 555 000 0000"
                value={item.number}
                onChange={(e) => edit(i, { ...item, number: e.target.value })}
              />
              <Fixed size="xs">
                <Input
                  aria-label={`Country code ${i + 1}`}
                  placeholder="US"
                  maxLength={2}
                  value={item.countryCode ?? ''}
                  onChange={(e) => edit(i, { ...item, countryCode: e.target.value || undefined })}
                />
              </Fixed>
            </>
          ) : (
            <>
              <Input
                aria-label={`URL ${i + 1}`}
                value={item.url}
                placeholder="https://"
                onChange={(e) => edit(i, { ...item, url: e.target.value })}
              />
              <Fixed size="sm">
                <Input
                  aria-label={`Link label ${i + 1}`}
                  placeholder="Label"
                  value={item.label ?? ''}
                  onChange={(e) => edit(i, { ...item, label: e.target.value })}
                />
              </Fixed>
            </>
          )}
          {values.length > 1 ? (
            <Button
              variant="ghost"
              size="iconSmall"
              aria-label={i === 0 ? 'Primary' : 'Set primary'}
              title={i === 0 ? 'Primary' : 'Set primary'}
              disabled={i === 0}
              onClick={() => commit([item, ...values.filter((_, n) => n !== i)])}
            >
              <Star size={13} fill={i === 0 ? 'currentColor' : 'none'} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="iconSmall"
            aria-label={`Remove ${noun} ${i + 1}`}
            title="Remove"
            onClick={() => commit(values.filter((_, n) => n !== i))}
          >
            <X size={13} />
          </Button>
        </Row>
      ))}
      <Row>
        <Button
          variant="ghost"
          size="small"
          disabled={
            field.settings.maxValues !== undefined && values.length >= field.settings.maxValues
          }
          onClick={() =>
            commit([
              ...values,
              field.type === 'emails'
                ? ''
                : field.type === 'phones'
                  ? { number: '' }
                  : { url: '', label: '' },
            ])
          }
        >
          <Plus size={14} />
          Add {noun}
        </Button>
      </Row>
    </Stack>
  );
}
const ADDRESS_PARTS = [
  ['city', 'City'],
  ['state', 'State or region'],
  ['postcode', 'Postal code'],
  ['country', 'Country'],
] as const;
export function FieldInput(props: InputProps) {
  const { field, value, onChange } = props;
  switch (field.type) {
    case 'json':
      return <FieldDisplay field={field} value={value} />;
    case 'boolean':
      return (
        <CheckLabel>
          <Input
            type="checkbox"
            role="switch"
            aria-label={field.label}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{value === true ? 'Yes' : 'No'}</span>
        </CheckLabel>
      );
    case 'number':
      return (
        <Input
          aria-label={field.label}
          type="number"
          step="any"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'text':
      return (
        <Input
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <Input
          aria-label={field.label}
          type="date"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'date_time': {
      const raw = value ? new Date(String(value)) : null;
      const local =
        raw && Number.isFinite(raw.getTime())
          ? new Date(raw.getTime() - raw.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
          : '';
      return (
        <Input
          aria-label={field.label}
          type="datetime-local"
          value={local}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    }
    case 'select':
      return <OptionsMenu {...props} clearable={field.isNullable} />;
    case 'multi_select':
      return <OptionsMenu {...props} multiple />;
    case 'full_name': {
      const v = (value ?? { first: '', last: '' }) as FullNameValue;
      return (
        <Columns>
          <Label quiet>
            First name
            <Input value={v.first} onChange={(e) => onChange({ ...v, first: e.target.value })} />
          </Label>
          <Label quiet>
            Last name
            <Input value={v.last} onChange={(e) => onChange({ ...v, last: e.target.value })} />
          </Label>
        </Columns>
      );
    }
    case 'address': {
      const v = (value ?? {}) as AddressValue;
      const part = (k: keyof AddressValue & string, label: string) => (
        <Label quiet key={k}>
          {label}
          <Input
            value={String(v[k] ?? '')}
            onChange={(e) => onChange({ ...v, [k]: e.target.value })}
          />
        </Label>
      );
      return (
        <Stack gap="small">
          {part('street1', 'Street')}
          {part('street2', 'Street line 2')}
          <Columns>{ADDRESS_PARTS.map(([k, label]) => part(k, label))}</Columns>
          {v.lat !== undefined || v.lng !== undefined ? (
            <Muted small>
              Coordinates: {v.lat}, {v.lng}
            </Muted>
          ) : null}
        </Stack>
      );
    }
    case 'money':
      return <MoneyInput {...props} />;
    case 'emails':
    case 'phones':
    case 'links':
      return <ListInput {...props} />;
    case 'relation':
      return <RelationInput {...props} />;
  }
}
export function FieldFilter({
  field,
  value,
  onChange,
  operator,
  references,
}: InputProps & { operator: string }) {
  if (operator === 'isNull' || operator === 'isEmpty')
    return (
      <SelectMenu
        label="Is empty"
        fill
        options={[
          { value: 'true', label: 'Is empty' },
          { value: 'false', label: 'Is not empty' },
        ]}
        value={value === false ? 'false' : 'true'}
        onChange={(v) => onChange(v === 'true')}
      />
    );
  // Records a set holds any or all of; or, for one record, any of several.
  if (
    operator === 'containsAny' ||
    operator === 'containsAll' ||
    (field.type === 'relation' && operator === 'in')
  )
    return (
      <RelationInput
        field={field}
        multiple
        value={relationIds(value)}
        onChange={onChange}
        references={references}
      />
    );
  if (field.type === 'money')
    return (
      <Input
        aria-label="Amount to compare"
        inputMode="decimal"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  // Several options of a select; one option a multi select contains.
  if (field.type === 'select' && operator === 'in')
    return <OptionsMenu field={field} value={value} onChange={onChange} multiple />;
  if (field.type === 'multi_select')
    return <OptionsMenu field={field} value={value} onChange={onChange} />;
  if (operator === 'in')
    return (
      <Textarea
        aria-label="Filter values as JSON array"
        value={typeof value === 'string' ? value : JSON.stringify(value ?? [])}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (['emails', 'phones', 'links', 'full_name', 'address'].includes(field.type))
    return (
      <Input
        aria-label="Filter value"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <FieldInput field={field} value={value} onChange={onChange} />;
}
export function filterValue(field: FieldView, operator: string, value: unknown): unknown {
  if (operator === 'isNull' || operator === 'isEmpty') return value !== false;
  if (
    operator === 'containsAny' ||
    operator === 'containsAll' ||
    (field.type === 'relation' && operator === 'in')
  ) {
    const ids = relationIds(value);
    if (!ids.length) throw new Error('Choose at least one record');
    return ids;
  }
  if (field.type === 'money') return decimalToMicros(String(value));
  if (operator === 'in') {
    const parsed = Array.isArray(value)
      ? value
      : typeof value === 'string' && value.trim()
        ? JSON.parse(value)
        : [];
    if (!Array.isArray(parsed) || !parsed.length)
      throw new Error(
        field.type === 'select' ? 'Choose at least one option' : 'Use a nonempty JSON array',
      );
    return parsed;
  }
  if (field.type === 'multi_select' && !value) throw new Error('Choose an option');
  if (['emails', 'phones', 'links', 'full_name', 'address', 'multi_select'].includes(field.type))
    return value;
  return normalizeFieldValue(field, value);
}
