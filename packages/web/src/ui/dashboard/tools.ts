import type {
  AggregateInput,
  AggregateResult,
  AggregateValue,
  PresentedRecord,
  QueryInput,
  RetainerClientLike,
} from './types.js';

/**
 * The data tools a dashboard's `Query` calls (`DASHBOARD_TOOLS` in shared).
 * They run here, in the viewer's browser, through the REST API with the
 * viewer's own session: a dashboard never sees more than its viewer can.
 * Read-only by construction: there is no write tool to call.
 */

/** A field value made plain for charts and tables. */
export function plainValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map(plainValue).filter((v) => v !== null && v !== '');
    return items.length ? items.join(', ') : null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.amountMicros === 'number') return v.amountMicros / 1_000_000;
  if ('first' in v || 'last' in v) return [v.first, v.last].filter(Boolean).join(' ') || null;
  if (typeof v.primaryEmail === 'string') return v.primaryEmail;
  if (typeof v.primaryPhoneNumber === 'string') return v.primaryPhoneNumber;
  if (typeof v.primaryLinkUrl === 'string') return v.primaryLinkUrl;
  if (typeof v.id === 'string') return v.id;
  return JSON.stringify(value);
}

function plainRecord(record: PresentedRecord) {
  const row: Record<string, unknown> = { id: record.id, label: record.label };
  for (const [name, value] of Object.entries(record.fields)) row[name] = plainValue(value);
  return row;
}

function plainAggregates(values: AggregateValue[]) {
  const out: Record<string, unknown> = {};
  for (const v of values) out[`${v.op}_${v.field}`] = plainValue(v.value);
  return out;
}

const object = (args: Record<string, unknown>) => {
  if (typeof args.object !== 'string' || !args.object) throw new Error('object is required');
  return args.object;
};

export function dashboardTools(client: RetainerClientLike) {
  return {
    async query_records(args: Record<string, unknown>) {
      const { object: _, limit, ...rest } = args;
      const page = await client.queryRecords(object(args), {
        ...(rest as QueryInput),
        limit: Math.min(200, typeof limit === 'number' ? limit : 50),
      });
      return { records: page.records.map(plainRecord) };
    },
    async aggregate_records(args: Record<string, unknown>) {
      const { object: _, ...rest } = args;
      const result: AggregateResult = await client.aggregate(object(args), rest as AggregateInput);
      return {
        total: result.total,
        values: plainAggregates(result.values),
        groups: (result.groups ?? []).map((g) => ({
          label: g.value,
          total: g.total,
          ...plainAggregates(g.values),
        })),
      };
    },
  };
}
