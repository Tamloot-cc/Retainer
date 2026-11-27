import type { DashboardIssue } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { checkAggregate } from '../records/aggregate.js';
import {
  builtInNames,
  checkQuery,
  EVENT_FILTER_NAMES,
  EVENT_QUERY_OBJECT,
} from '../records/query.js';
import { type CompiledSchema, objectNamed } from '../schema/compiled.js';
import { inspectDashboard, rewriteQueries } from './program.js';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function translateDashboard(
  tx: Tx,
  program: string,
  schema: CompiledSchema,
  mode: 'store' | 'read',
) {
  const { queries, problems, parsed } = inspectDashboard(program, mode === 'read');
  const issues: DashboardIssue[] = [...problems];
  const rewritten = rewriteQueries(program, queries, (query) => {
    const name = query.args.object;
    const events = name === EVENT_QUERY_OBJECT;
    const object = mode === 'store' ? objectNamed(schema, name) : schema.objectsById.get(name);
    const messages = new Set<string>();
    const issue = (message: string) => {
      if (messages.has(message)) return;
      messages.add(message);
      issues.push({ statement: query.statement, message });
    };
    const validate = (check: () => void) => {
      // A stale reference already has a more useful diagnostic.
      if (messages.size) return;
      try {
        check();
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          (error.code !== 'invalid_filter' && error.code !== 'invalid_aggregate')
        )
          throw error;
        issue(error.message);
      }
    };
    if (
      !events &&
      (object?.state.status !== 'active' || objectNamed(schema, object.name)?.id !== object.id)
    ) {
      issue(
        mode === 'store'
          ? `Unknown object "${name}"`
          : 'This query uses an object that was removed',
      );
      return {
        ...query.args,
        object:
          mode === 'read' && (!object || objectNamed(schema, object.name))
            ? 'removed-object'
            : (object?.name ?? name),
      };
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
      // Field keys are never reused. A recreated name must not retarget an old query.
      if (mode === 'store') return key;
      if (removed && !builtin.has(removed.name) && !object?.fieldsByName.has(removed.name))
        return removed.name;
      return `removed-field-${key}`;
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
      if (!type?.isEvent || objectNamed(schema, type.name)?.id !== type.id) {
        issue(
          mode === 'store'
            ? `Unknown event type "${value}"`
            : 'This query uses an event type that was removed',
        );
        if (mode === 'store') return value;
        return type && !objectNamed(schema, type.name) ? type.name : 'removed-event-type';
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
          return [translateField(key), value];
        }),
      );
    const translatedFilter = query.args.filter && filter(query.args.filter);
    const translatedObject = object ? (mode === 'store' ? object.id : object.name) : name;
    if (query.tool === 'query_records') {
      const { args } = query;
      const translated = {
        ...args,
        object: translatedObject,
        filter: translatedFilter,
        sort: args.sort?.map((item) => ({ ...item, field: translateField(item.field) })),
        fields: Object.fromEntries(
          Object.entries(args.fields).map(([alias, field]) => [alias, translateField(field)]),
        ),
      };
      validate(() => checkQuery(tx, schema, object, mode === 'store' ? args : translated));
      return translated;
    }
    const { args } = query;
    const translated = {
      ...args,
      object: translatedObject,
      filter: translatedFilter,
      groupBy: args.groupBy === undefined ? undefined : translateField(args.groupBy),
      aggregates: args.aggregates?.map((item) => ({ ...item, field: translateField(item.field) })),
    };
    validate(() => checkAggregate(tx, schema, object, mode === 'store' ? args : translated));
    return translated;
  });
  return { program: rewritten, issues, queries, parsed };
}
