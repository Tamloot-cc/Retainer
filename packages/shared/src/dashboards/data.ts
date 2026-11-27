import type {
  AggregateResult,
  AggregateValue,
  FieldView,
  PresentedRecord,
  RecordPage,
  RecordReference,
} from '../api.js';
import { primaryCopyValue } from '../values.js';

type DashboardField = Pick<FieldView, 'type'> & {
  settings: Pick<FieldView['settings'], 'options'>;
};

export function dashboardValue(
  value: unknown,
  field?: DashboardField,
  references?: Record<string, RecordReference>,
): unknown {
  if (value === null || value === undefined) return null;
  const option = (name: unknown) =>
    field?.settings.options?.find((item) => item.value === name)?.label ?? name;
  if (field?.type === 'select') return option(value);
  if (field?.type === 'multi_select' && Array.isArray(value)) return value.map(option).join(', ');
  if (field?.type === 'relation') {
    const label = (id: unknown) =>
      typeof id === 'string' ? (references?.[id]?.label ?? null) : null;
    return Array.isArray(value)
      ? value.map(label).filter(Boolean).join(', ') || null
      : label(value);
  }
  if (field?.type === 'emails' || field?.type === 'phones' || field?.type === 'links')
    return primaryCopyValue(field.type, value) ?? null;
  if (typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (typeof v.amountMicros === 'number' && typeof v.currency === 'string')
    return { amount: v.amountMicros / 1_000_000, currency: v.currency };
  if ('first' in v || 'last' in v) return [v.first, v.last].filter(Boolean).join(' ') || null;
  return value;
}

function plainAggregates(values: AggregateValue[]) {
  return Object.fromEntries(
    values.flatMap((item) =>
      !item.as
        ? []
        : [
            [
              item.as,
              item.mixedCurrencies ? { mixedCurrencies: true } : dashboardValue(item.value),
            ],
          ],
    ),
  );
}

function readField(row: PresentedRecord, field: string, allEvents: boolean): unknown {
  if (field === 'type' && allEvents) return row.object;
  if (Object.hasOwn(row.fields, field)) return row.fields[field];
  switch (field) {
    case 'id':
    case 'createdAt':
    case 'updatedAt':
      return row[field];
    case 'occurredAt':
    case 'channel':
    case 'externalId':
      return row.event?.[field];
    default:
      return undefined;
  }
}

export function dashboardRecordData(
  page: RecordPage,
  object: string,
  fields: Record<string, string>,
  fieldOf: (object: string, field: string) => DashboardField | undefined,
) {
  return {
    records: page.records.map((record) => ({
      id: record.id,
      label: record.label,
      ...Object.fromEntries(
        Object.entries(fields).map(([alias, name]) => [
          alias,
          dashboardValue(
            readField(record, name, object === 'event'),
            fieldOf(record.object, name),
            page.relationReferences,
          ),
        ]),
      ),
    })),
  };
}

export function dashboardAggregateData(result: AggregateResult) {
  return {
    total: result.total,
    values: plainAggregates(result.values),
    groups: (result.groups ?? []).map((group) => ({
      value: group.value,
      label: group.label,
      total: group.total,
      ...plainAggregates(group.values),
    })),
    ...(result.tooManyGroups ? { tooManyGroups: true } : {}),
  };
}
