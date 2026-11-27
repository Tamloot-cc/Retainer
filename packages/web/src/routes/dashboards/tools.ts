import type { RetainerClient } from '@retainer/sdk';
import {
  dashboardAggregateData,
  dashboardAggregateSchema,
  dashboardRecordData,
  dashboardRecordsSchema,
  type SchemaDescription,
} from '@retainer/shared';

// OpenUI exposes defaults through the same accessor as live data. Track
// successful results by identity so arbitrary defaults cannot look loaded.
const results = new WeakSet<object>();

export function isDashboardResult(data: unknown) {
  return !!data && typeof data === 'object' && results.has(data);
}

export function dashboardTools(
  client: Pick<RetainerClient, 'queryRecords' | 'aggregate'>,
  schema: SchemaDescription,
) {
  const definitions = new Map(
    schema.objects.map((entry) => [
      entry.nameSingular,
      new Map(entry.fields.map((field) => [field.name, field])),
    ]),
  );
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
        const data = dashboardRecordData(page, object, fields, (type, name) =>
          definitions.get(type)?.get(name),
        );
        results.add(data);
        return data;
      },
      async aggregate_records(args: Record<string, unknown>) {
        const { object, ...input } = dashboardAggregateSchema.parse(args);
        const data = dashboardAggregateData(await client.aggregate(object, input));
        results.add(data);
        return data;
      },
    },
  );
}
