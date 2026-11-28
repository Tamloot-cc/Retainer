import type { FieldView, ObjectView } from '@retainer/shared';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Columns3,
  ListFilter,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { filterValue } from '../../fields/common.js';
import { fields } from '../../fields/index.js';
import {
  ApiName,
  Button,
  Checkbox,
  Form,
  IconLabel,
  MenuItem,
  MenuLabel,
  MenuList,
  OptionList,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Popover,
  Segmented,
  SelectMenu,
} from '../../ui/index.js';
import { useAgentDescription, useApiName } from '../developer.js';
import { listFilterOperators } from '../events/event-list.js';
import {
  type FilterClause,
  isSortable,
  operatorLabel,
  type SortState,
  setColumnVisible,
  shiftColumn,
} from './list-state.js';

const BUILT_IN_SORTS = [
  { name: 'updatedAt', label: 'Updated' },
  { name: 'createdAt', label: 'Created' },
];

/** What a filter's value starts as when its operator is chosen. */
const initialFilterValue = (operator: string): unknown =>
  operator === 'isNull' || operator === 'isEmpty'
    ? true
    : operator === 'containsAny' || operator === 'containsAll'
      ? []
      : '';

const fieldOption = (f: FieldView, apiName?: string) => ({
  value: f.name,
  label: f.label,
  // Search finds a field by its API name too, where it is shown.
  ...(apiName ? { keywords: apiName } : {}),
  content: <FieldLabel field={f} />,
});

/** A field's name with its type's icon, and its API name in developer view. */
function FieldLabel({ field }: { field: FieldView }) {
  const apiName = useApiName()(field.name);
  const description = useAgentDescription()(field.description);
  return (
    <IconLabel icon={fields[field.type].icon}>
      {field.label}
      {apiName ? <ApiName title={description}>{apiName}</ApiName> : null}
    </IconLabel>
  );
}

/** Pick a field to sort by; the direction applies to whichever is chosen. */
export function SortMenu({
  object,
  sort,
  onChange,
}: {
  object: ObjectView;
  sort: SortState | undefined;
  onChange: (sort: SortState | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const options = [
    ...object.fields.filter(isSortable).map((f) => fieldOption(f)),
    ...BUILT_IN_SORTS.map((s) => ({ value: s.name, label: s.label })),
  ];
  const current = sort ? (options.find((o) => o.value === sort.field)?.label ?? sort.field) : '';
  const shownDirection = sort?.direction ?? direction;
  return (
    <Popover
      label="Sort records"
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="small">
          <ArrowUpDown size={14} />
          {sort ? `${current} ${sort.direction === 'asc' ? '↑' : '↓'}` : 'Sort'}
        </Button>
      }
    >
      <OptionList
        label="Sort by"
        placeholder="Search fields…"
        searchable={options.length > 7}
        options={options}
        selected={sort ? [sort.field] : []}
        onPick={(field) => {
          onChange({ field, direction: shownDirection });
          setOpen(false);
        }}
      />
      <PanelFooter>
        <Segmented
          label="Sort direction"
          value={shownDirection}
          options={[
            { value: 'asc', label: 'Ascending', icon: <ArrowUp size={12} /> },
            { value: 'desc', label: 'Descending', icon: <ArrowDown size={12} /> },
          ]}
          onChange={(next) => {
            setDirection(next);
            if (sort) onChange({ field: sort.field, direction: next });
          }}
        />
        {sort ? (
          <Button variant="ghost" size="small" onClick={() => onChange(undefined)}>
            <X size={14} />
            Clear
          </Button>
        ) : null}
      </PanelFooter>
    </Popover>
  );
}

/** First the field to filter on, from a searchable list; then its condition and value. */
export function FilterMenu({
  object,
  onApply,
  onError,
}: {
  object: ObjectView;
  onApply: (clause: FilterClause) => void;
  onError: (message: string) => void;
}) {
  const apiName = useApiName();
  const [open, setOpen] = useState(false),
    [field, setField] = useState(''),
    [operator, setOperator] = useState('eq'),
    [value, setValue] = useState<unknown>('');
  const selected = object.fields.find((f) => f.name === field);
  function choose(name: string) {
    const f = object.fields.find((f) => f.name === name);
    setField(name);
    const first = f ? (listFilterOperators(f)[0] ?? 'isNull') : 'eq';
    setOperator(first);
    setValue(f?.type === 'boolean' ? true : f?.type === 'number' ? 0 : initialFilterValue(first));
  }
  function apply() {
    if (!selected) return;
    try {
      onApply({ field: selected.name, operator, value: filterValue(selected, operator, value) });
      setOpen(false);
      setField('');
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <Popover
      label="Add a filter"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setField('');
      }}
      trigger={
        <Button variant="ghost" size="small" className="pointer-coarse:min-h-11">
          <ListFilter size={14} />
          Filter
        </Button>
      }
    >
      {selected ? (
        <>
          <PanelHeader
            title={<FieldLabel field={selected} />}
            back={{ label: 'Choose another field', onClick: () => setField('') }}
          />
          <PanelBody>
            <Form onSubmit={apply} autoFocus>
              <SelectMenu
                label="Filter operator"
                fill
                value={operator}
                options={listFilterOperators(selected).map((o) => ({
                  value: o,
                  label: operatorLabel(o),
                }))}
                onChange={(next) => {
                  setOperator(next);
                  setValue(initialFilterValue(next));
                }}
              />
              <FilterControl
                field={selected}
                value={value}
                operator={operator}
                onChange={setValue}
              />
              <Button type="submit" variant="primary" className="pointer-coarse:min-h-11">
                Apply filter
              </Button>
            </Form>
          </PanelBody>
        </>
      ) : (
        <OptionList
          label="Filter by"
          placeholder="Search fields…"
          options={object.fields
            .filter((f) => f.isFilterable)
            .map((f) => fieldOption(f, apiName(f.name)))}
          empty="No fields match"
          onPick={choose}
        />
      )}
    </Popover>
  );
}

/** `columns` is what the grid shows, label first; `order` is the rest by name. */
export function ColumnsMenu({
  title,
  object,
  columns,
  order,
  onChange,
  onReset,
}: {
  /** "Columns" for a table, "Card fields" for a board. */
  title: string;
  object: ObjectView;
  columns: FieldView[];
  order: string[];
  onChange: (order: string[]) => void;
  onReset: () => void;
}) {
  const label = columns.find((f) => f.name === object.labelField);
  const shown = columns.filter((f) => f !== label);
  const hidden = object.fields.filter(
    (f) => f.name !== object.labelField && !order.includes(f.name),
  );
  return (
    <Popover
      label={title === 'Columns' ? 'Visible columns' : title}
      align="end"
      trigger={
        <Button size="small">
          <Columns3 size={14} />
          {title}
        </Button>
      }
    >
      <PanelHeader
        title={title}
        action={
          <Button variant="ghost" size="small" onClick={onReset}>
            Reset
          </Button>
        }
      />
      <MenuList>
        <MenuLabel>Shown</MenuLabel>
        {label ? (
          <MenuItem>
            <Checkbox checked disabled label={<FieldLabel field={label} />} truncate />
          </MenuItem>
        ) : null}
        {shown.map((f, i) => (
          <MenuItem
            key={f.name}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="iconSmall"
                  aria-label={`Move ${f.label} left`}
                  title="Move left"
                  disabled={i === 0}
                  onClick={() => onChange(shiftColumn(order, f.name, -1))}
                >
                  <ChevronUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSmall"
                  aria-label={`Move ${f.label} right`}
                  title="Move right"
                  disabled={i === shown.length - 1}
                  onClick={() => onChange(shiftColumn(order, f.name, 1))}
                >
                  <ChevronDown size={14} />
                </Button>
              </>
            }
          >
            <Checkbox
              checked
              onChange={() => onChange(setColumnVisible(order, f.name, false))}
              label={<FieldLabel field={f} />}
              truncate
            />
          </MenuItem>
        ))}
        {hidden.length ? <MenuLabel>Hidden</MenuLabel> : null}
        {hidden.map((f) => (
          <MenuItem key={f.name} muted>
            <Checkbox
              checked={false}
              onChange={() => onChange(setColumnVisible(order, f.name, true))}
              label={<FieldLabel field={f} />}
              truncate
            />
          </MenuItem>
        ))}
      </MenuList>
    </Popover>
  );
}

function FilterControl(props: {
  field: FieldView;
  value: unknown;
  operator: string;
  onChange: (v: unknown) => void;
}) {
  const Filter = fields[props.field.type].Filter;
  return <Filter {...props} />;
}
