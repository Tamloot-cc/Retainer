import type { RetainerClient } from '@retainer/sdk';
import {
  type AggregateValue,
  dashboardAggregateSchema,
  dashboardRecordsSchema,
  type FieldView,
  type PresentedRecord,
  type RecordReference,
  type SchemaDescription,
} from '@retainer/shared';

export type DashboardMoney = { amount: number; currency: string };
export type DashboardValue = number | string | null | DashboardMoney | { mixedCurrencies: true };

export function plainValue(
  value: unknown,
  field?: FieldView,
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
  if (typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (typeof v.amountMicros === 'number' && typeof v.currency === 'string')
    return { amount: v.amountMicros / 1_000_000, currency: v.currency };
  if ('first' in v || 'last' in v) return [v.first, v.last].filter(Boolean).join(' ') || null;
  for (const key of ['primaryEmail', 'primaryPhoneNumber', 'primaryLinkUrl']) {
    if (typeof v[key] === 'string') return v[key];
  }
  return value;
}

function plainAggregates(values: AggregateValue[]) {
  return Object.fromEntries(
    values.flatMap((item) =>
      !item.as
        ? []
        : [[item.as, item.mixedCurrencies ? { mixedCurrencies: true } : plainValue(item.value)]],
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

export function dashboardTools(
  client: Pick<RetainerClient, 'queryRecords' | 'aggregate'>,
  schema: SchemaDescription,
) {
  // The renderer also looks up tool names through this object. Limit it to
  // exactly these two reads, including when the program is still streaming.
  return Object.assign(
    Object.create(null) as Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
    {
      async query_records(args: Record<string, unknown>) {
        const { object, fields, ...input } = dashboardRecordsSchema.parse(args);
        const page = await client.queryRecords(object, {
          ...input,
          include: ['relationReferences'],
        });
        return {
          records: page.records.map((record) => {
            const objectSchema = schema.objects.find(
              (entry) => entry.nameSingular === record.object,
            );
            const definitions = new Map(objectSchema?.fields.map((field) => [field.name, field]));
            return {
              id: record.id,
              label: record.label,
              ...Object.fromEntries(
                Object.entries(fields).map(([alias, name]) => [
                  alias,
                  plainValue(
                    readField(record, name, object === 'event'),
                    definitions.get(name),
                    page.relationReferences,
                  ),
                ]),
              ),
            };
          }),
        };
      },
      async aggregate_records(args: Record<string, unknown>) {
        const { object, ...input } = dashboardAggregateSchema.parse(args);
        const result = await client.aggregate(object, input);
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
      },
    },
  );
}
