import {
  type ObjectView,
  relationTargets,
  type SavedView,
  type UpdateViewInput,
} from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, useWorkspace } from '../../api/client.js';
import { recordTitle } from '../state.js';
import { aggregateLabel, isPlainObject, operatorLabel } from './list-state.js';

/** The built-in date columns every record or event has. */
const BUILT_IN_LABELS = new Map([
  ['createdAt', 'Created at'],
  ['updatedAt', 'Updated at'],
  ['occurredAt', 'Occurred at'],
]);

export function fieldLabel(object: ObjectView, key: string) {
  return (
    object.fields.find((field) => field.name === key)?.label ?? BUILT_IN_LABELS.get(key) ?? key
  );
}

function valueLabel(value: unknown, options: Map<string, string>, relative: boolean): string {
  if (Array.isArray(value))
    return value.map((item) => valueLabel(item, options, relative)).join(' or ');
  if (typeof value === 'string')
    return options.get(value) ?? (relative ? value.replaceAll('_', ' ') : value);
  if (isPlainObject(value)) {
    for (const [direction, count] of Object.entries(value)) {
      if (typeof count !== 'number' || typeof value.unit !== 'string') continue;
      const amount = `${count} ${value.unit}${count === 1 ? '' : 's'}`;
      if (direction === 'ago') return `${amount} ago`;
      if (direction === 'ahead') return `${amount} from today`;
      if (direction === 'last' || direction === 'next') return `the ${direction} ${amount}`;
    }
    const label = [value.first, value.last, value.city, value.country].filter(Boolean).join(' ');
    return (
      label ||
      Object.values(value)
        .map((item) => valueLabel(item, options, false))
        .join(' ')
    );
  }
  return String(value);
}

export function describeFilter(filter: Record<string, unknown>, object: ObjectView): string {
  return (
    Object.entries(filter)
      .map(([field, condition]) => {
        if ((field === 'and' || field === 'or') && Array.isArray(condition)) {
          const children = condition
            .filter(isPlainObject)
            .map((part) => describeFilter(part, object));
          return children.length > 1
            ? `(${children.join(` ${field} `)})`
            : (children[0] ?? (field === 'and' ? 'All records' : 'No records'));
        }
        if (field === 'not' && isPlainObject(condition))
          return `Not (${describeFilter(condition, object)})`;
        const label = fieldLabel(object, field);
        const options = new Map(
          object.fields
            .find((item) => item.name === field)
            ?.settings.options?.map((option) => [option.value, option.label]),
        );
        return Object.entries(isPlainObject(condition) ? condition : { eq: condition })
          .map(([op, value]) => {
            if (op === 'isNull' || op === 'isEmpty')
              return `${label} is ${value ? '' : 'not '}empty`;
            const relative = op === 'within' || ['gt', 'gte', 'lt', 'lte'].includes(op);
            const operator = (
              {
                gt: 'is after',
                gte: 'is on or after',
                lt: 'is before',
                lte: 'is on or before',
              } as Record<string, string>
            )[op];
            const date =
              object.fields.some(
                (f) => f.name === field && (f.type === 'date' || f.type === 'date_time'),
              ) || BUILT_IN_LABELS.has(field);
            return `${label} ${(date && operator) || operatorLabel(op)} ${valueLabel(value, options, relative)}`;
          })
          .join(' and ');
      })
      .filter(Boolean)
      .join(' and ') || 'All records'
  );
}

export function SettingsSummary({
  view,
  object,
  filters,
  change,
}: {
  view: SavedView;
  object: ObjectView;
  filters: { text: string; remove?: () => void }[];
  change?: (patch: UpdateViewInput) => void;
}) {
  const { session } = useWorkspace();
  const field = object.fields.find((item) => item.name === view.groupBy);
  const targets = field?.type === 'relation' ? relationTargets(field) : [];
  const ids = view.hiddenGroups.filter((id): id is string => id !== null);
  const labels = useQuery({
    queryKey: [session.workspace.id, 'view-group-labels', targets, ids],
    enabled: targets.length > 0 && ids.length > 0,
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        targets.map((target) =>
          api.queryRecords(target, { filter: { id: { in: ids } }, limit: 200 }, signal),
        ),
      );
      return Object.fromEntries(
        pages.flatMap((page) => page.records.map((record) => [record.id, recordTitle(record)])),
      );
    },
  });
  const parts: { text: string; remove?: () => void }[] = [];
  function add(text: string, patch: UpdateViewInput) {
    parts.push({ text, remove: change ? () => change(patch) : undefined });
  }
  const label = (name: string) => fieldLabel(object, name);
  if (view.kind !== 'table')
    add(view.kind === 'board' ? 'Board layout' : 'Calendar layout', {
      kind: 'table',
      dateField: null,
    });
  if (view.groupBy) {
    add(`Grouped by ${label(view.groupBy)}`, {
      groupBy: null,
      granularity: null,
      groupOrder: null,
      hideEmptyGroups: null,
      hiddenGroups: null,
      groupAggregate: null,
      ...(view.kind === 'board' ? { kind: 'table' } : {}),
    });
    if (view.granularity) add(`By ${view.granularity}`, { granularity: null });
    if (view.groupOrder && view.groupOrder !== 'default')
      add(view.groupOrder === 'asc' ? 'Groups ascending' : 'Groups descending', {
        groupOrder: null,
      });
    else if (field?.type === 'relation') parts.push({ text: 'Most records first' });
    if (view.hideEmptyGroups) add('Empty groups hidden', { hideEmptyGroups: null });
    if (view.hiddenGroups.length) {
      const options = new Map(
        field?.settings.options?.map((option) => [option.value, option.label]),
      );
      const values = view.hiddenGroups.map((value) =>
        value === null ? 'No value' : (options.get(value) ?? labels.data?.[value] ?? value),
      );
      add(`Hidden groups: ${values.join(', ')}`, { hiddenGroups: null });
    }
    if (view.groupAggregate) {
      const { field, op } = view.groupAggregate;
      const schemaField = object.fields.find((item) => item.name === field);
      add(`${schemaField ? aggregateLabel(schemaField, op) : op} of ${label(field)} per group`, {
        groupAggregate: null,
      });
    }
  }
  if (view.kind === 'calendar' && view.dateField)
    add(`Placed by ${label(view.dateField)}`, { dateField: null, kind: 'table' });
  if (view.sort?.length)
    view.sort.forEach(({ field, direction }, index) => {
      const type = object.fields.find((item) => item.name === field)?.type;
      const order =
        type === 'number' || type === 'money'
          ? direction === 'desc'
            ? 'largest first'
            : 'smallest first'
          : direction === 'desc'
            ? 'descending'
            : 'ascending';
      add(`Sorted by ${label(field)}, ${order}`, {
        sort: view.sort?.filter((_, i) => i !== index) ?? null,
      });
    });
  if (view.columns) {
    const columns = view.columns;
    add(
      `Columns: ${[object.labelField, ...view.columns.order]
        .filter((name): name is string => !!name)
        .map(label)
        .join(', ')}`,
      { columns: null },
    );
    if (columns.widths && Object.keys(columns.widths).length > 0) {
      const { widths, ...defaults } = columns;
      add(
        `Column widths · ${Object.entries(widths)
          .map(([name, width]) => `${label(name)} ${width} px`)
          .join(', ')}`,
        { columns: defaults },
      );
    }
    for (const [name, op] of Object.entries(columns.aggregates ?? {})) {
      const field = object.fields.find((item) => item.name === name);
      if (!field) continue;
      const aggregates = { ...columns.aggregates };
      delete aggregates[name];
      add(`${aggregateLabel(field, op)} of ${label(name)} in the footer`, {
        columns: { ...columns, aggregates },
      });
    }
  }
  parts.push(...filters);
  if (view.search) add(`Matching “${view.search}”`, { search: null });
  if (!parts.length) return null;
  return (
    <ul
      aria-label="View settings"
      title={view.description ?? undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {parts.map(({ text, remove }) => (
        <li key={text} className="inline-flex min-w-0 items-center gap-1 wrap-anywhere">
          {text}
          {remove && (
            <button
              type="button"
              onClick={remove}
              aria-label={`Remove ${text}`}
              className="rounded p-1.5 hover:bg-muted hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
