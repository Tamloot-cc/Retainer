import type { DashboardIssue } from '@retainer/shared';
import { builtInNames, EVENT_FILTER_NAMES, EVENT_QUERY_OBJECT } from '../records/query.js';
import { type CompiledSchema, objectNamed } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import { inspectDashboard, rewriteQueries } from './program.js';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function translateDashboard(
  program: string,
  schema: CompiledSchema,
  mode: 'store' | 'read',
) {
  const { queries, problems } = inspectDashboard(program, mode === 'read');
  const issues: DashboardIssue[] = [...problems];
  const rewritten = rewriteQueries(program, queries, (query) => {
    const name = query.args.object;
    const events = name === EVENT_QUERY_OBJECT;
    const object = mode === 'store' ? objectNamed(schema, name) : schema.objectsById.get(name);
    const issue = (message: string) => issues.push({ statement: query.statement, message });
    if (!events && (object?.state.status !== 'active' || !schema.objectsByName.has(object.name))) {
      issue(
        mode === 'store'
          ? `Unknown object "${name}"`
          : 'This query uses an object that was removed',
      );
      return { ...query.args, object: mode === 'read' ? (object?.name ?? 'removed-object') : name };
    }
    const builtin = new Set(object ? builtInNames(object) : EVENT_FILTER_NAMES);
    const fields = new Map(
      object?.activeFields.map((field) => [mode === 'store' ? field.name : field.key, field]),
    );
    const translateField = (key: string) => {
      if (builtin.has(key)) return key;
      const field = fields.get(key);
      if (field) return mode === 'store' ? field.key : field.name;
      const removed = object?.state.fields.find((field) => field.key === key);
      issue(
        mode === 'store'
          ? `${name} has no field "${key}"`
          : `${object?.name ?? 'event'} uses a field that was removed${removed ? ` ("${removed.label}")` : ''}`,
      );
      // Keep an invalid reference so a viewer cannot accidentally run a broader query.
      return mode === 'read' ? (removed?.name ?? key) : key;
    };
    const checkOptions = (field: FieldState | undefined, condition: unknown) => {
      if (field?.type !== 'select' && field?.type !== 'multi_select') return;
      const predicates = asObject(condition);
      const values = predicates
        ? Object.entries(predicates)
            .filter(([op]) => op !== 'isNull')
            .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
        : [condition];
      const options = new Set(field.settings.options?.map(({ value }) => value));
      for (const value of values) {
        if (typeof value === 'string' && !options.has(value))
          issue(`"${field.name}" has no option "${value}"`);
      }
    };
    const eventType = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(eventType);
      const predicates = asObject(value);
      if (predicates)
        return Object.fromEntries(
          Object.entries(predicates).map(([op, item]) => [op, eventType(item)]),
        );
      if (typeof value !== 'string') return value;
      const type = mode === 'store' ? objectNamed(schema, value) : schema.objectsById.get(value);
      if (!type?.isEvent || !schema.objectsByName.has(type.name)) {
        issue(
          mode === 'store'
            ? `Unknown event type "${value}"`
            : 'This query uses an event type that was removed',
        );
        return mode === 'read' ? (type?.name ?? 'removed-event-type') : value;
      }
      return mode === 'store' ? type.id : type.name;
    };
    const filter = (tree: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(tree).map(([key, value]) => {
          if ((key === 'and' || key === 'or') && Array.isArray(value))
            return [
              key,
              value.map((item) => {
                const nested = asObject(item);
                return nested ? filter(nested) : item;
              }),
            ];
          const nested = key === 'not' && asObject(value);
          if (nested) return [key, filter(nested)];
          if (events && key === 'type') return [key, eventType(value)];
          checkOptions(fields.get(key), value);
          return [translateField(key), value];
        }),
      );
    const { args } = query;
    const common = {
      ...args,
      object: object ? (mode === 'store' ? object.id : object.name) : name,
      ...(args.filter ? { filter: filter(args.filter) } : {}),
    };
    if (query.tool === 'query_records') {
      return {
        ...common,
        ...(query.args.sort
          ? {
              sort: query.args.sort.map((item) => ({ ...item, field: translateField(item.field) })),
            }
          : {}),
        fields: Object.fromEntries(
          Object.entries(query.args.fields).map(([alias, field]) => [alias, translateField(field)]),
        ),
      };
    }
    return {
      ...common,
      ...(query.args.groupBy !== undefined ? { groupBy: translateField(query.args.groupBy) } : {}),
      ...(query.args.aggregates
        ? {
            aggregates: query.args.aggregates.map((item) => ({
              ...item,
              field: translateField(item.field),
            })),
          }
        : {}),
    };
  });
  return { program: rewritten, issues, queries };
}
