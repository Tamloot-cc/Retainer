import {
  type ASTNode,
  dataSources,
  evaluateElementProps,
  isElementNode,
  type OpenUIError,
  type ParseResult,
  parseExpression,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import type { DashboardIssue, dashboardRecordsSchema } from '@retainer/shared';
import type { z } from 'zod';
import { type CompiledSchema, objectNamed } from '../schema/compiled.js';
import { dashboardLibrary } from './program.js';

export type DashboardRecordRead = {
  args: z.infer<typeof dashboardRecordsSchema>;
  truncated: boolean;
};

/** Check what the browser renders for metrics, using the same projected query results. */
export function checkDashboardMetrics(
  parsed: ParseResult,
  results: Map<string, unknown>,
  recordReads: Map<string, DashboardRecordRead>,
  schema: CompiledSchema,
): DashboardIssue[] {
  const sources = dataSources(parsed);
  if (!sources) return [];
  const problems: DashboardIssue[] = [];
  const formulas = new Map(
    Object.entries(sources.formulas).map(([name, expr]) => [name, parseExpression(tokenize(expr))]),
  );
  // Program validation already rejects circular references.
  const resolve = (node: ASTNode | undefined): ASTNode | undefined =>
    node?.k === 'Ref' && formulas.has(node.n) ? resolve(formulas.get(node.n)) : node;

  function checkCount(node: ASTNode, report: (message: string) => void) {
    if (node.k !== 'Comp' || node.name !== 'Count') return;
    const operand = resolve(node.args[0]);
    let rows = operand;
    while (rows?.k === 'Comp' && ['Filter', 'Sort'].includes(rows.name))
      rows = resolve(rows.args[0]);
    if (rows?.k !== 'Member' || rows.field !== 'records') return;
    const query = resolve(rows.obj);
    const read = query?.k === 'Ref' && recordReads.get(query.n);
    if (!read) return;
    if (read.truncated)
      report(
        'This metric counts a partial page of records. Use aggregate_records for a full count.',
      );

    let filter = operand;
    while (filter?.k === 'Comp' && ['Filter', 'Sort'].includes(filter.name)) {
      if (filter.name === 'Filter') {
        const [, alias, operator, value] = filter.args.map(resolve);
        if (
          alias?.k === 'Str' &&
          operator?.k === 'Str' &&
          ['==', '!=', 'contains'].includes(operator.v) &&
          value?.k === 'Str' &&
          Object.hasOwn(read.args.fields, alias.v)
        ) {
          const fieldName = read.args.fields[alias.v];
          const field = fieldName
            ? objectNamed(schema, read.args.object)?.fieldsByName.get(fieldName)
            : undefined;
          if (field?.type === 'select' || field?.type === 'multi_select') {
            const options = field.settings.options ?? [];
            const option = options.find(({ value: key }) => key === value.v);
            const matchesLabel = options.some(({ label }) =>
              operator.v === 'contains' ? label.includes(value.v) : label === value.v,
            );
            if (option && !matchesLabel)
              report(
                `The filter on "${alias.v}" uses the stored option "${value.v}", but the dashboard rows display "${option.label}". Use a filtered aggregate_records query for this count.`,
              );
          }
        }
      }
      filter = resolve(filter.args[0]);
    }
  }

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isElementNode(node)) return;
    if (node.typeName !== 'Metric') {
      Object.values(node.props).forEach(visit);
      return;
    }
    const statement = node.componentId ?? node.statementId ?? 'root';
    const source = sources?.components[statement]?.props.value;
    if (!source?.queries.length || !source.queries.every((name) => results.has(name))) return;
    const report = (message: string) => {
      if (!problems.some((issue) => issue.statement === statement && issue.message === message))
        problems.push({ statement, message });
    };
    let hasLoop = false;
    for (const expression of [
      parseExpression(tokenize(source.expr)),
      ...source.via.flatMap((name) => {
        const formula = formulas.get(name);
        return formula ? [formula] : [];
      }),
    ]) {
      walkAST(expression, (part) => {
        if (part.k === 'Comp' && part.name === 'Each') hasLoop = true;
        checkCount(part, report);
      });
    }
    // Each can expand a list repeatedly. Keep live checking bounded to
    // scalar metric expressions and let the browser render list templates.
    if (hasLoop) return;
    const errors: OpenUIError[] = [];
    const metric = evaluateElementProps(
      { ...node, props: { value: node.props.value } },
      {
        library: dashboardLibrary,
        store: null,
        ctx: { getState: () => null, resolveRef: (name) => results.get(name), functions: {} },
        errors,
      },
    );
    for (const error of errors) report(error.message);
    if (
      !dashboardLibrary.components.Metric?.props.shape.value?.safeParse(metric.props.value).success
    )
      report('The metric value does not resolve to a supported display value.');
  }

  visit(parsed.root);
  return problems;
}
