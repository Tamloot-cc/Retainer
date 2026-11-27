import {
  type ASTNode,
  createLibrary,
  createParser,
  defineComponent,
  type ParseResult,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import {
  DASHBOARD_COMPONENT_NAMES,
  DASHBOARD_FORBIDDEN_KEYS,
  DASHBOARD_MAX_BYTES,
  DASHBOARD_MAX_QUERIES,
  type DashboardComponentName,
  type DashboardIssue,
  dashboardAggregateSchema,
  dashboardComponents,
  dashboardRecordsSchema,
  validDashboardRefresh,
} from '@retainer/shared';
import type { z } from 'zod';

export const dashboardLibrary = createLibrary({
  root: 'Dashboard',
  components: dashboardComponents(
    defineComponent,
    Object.fromEntries(DASHBOARD_COMPONENT_NAMES.map((name) => [name, null])) as Record<
      DashboardComponentName,
      null
    >,
  ),
});
const parser = createParser(dashboardLibrary.toJSONSchema(), 'Dashboard');
// OpenUI Lang 1.0 built-ins that operate on values. Its action steps are
// deliberately excluded, including when they are in an unused statement.
const valueFunctions = new Set([
  'Count',
  'First',
  'Last',
  'Sum',
  'Avg',
  'Min',
  'Max',
  'Sort',
  'Filter',
  'Round',
  'Abs',
  'Floor',
  'Ceil',
  'Each',
]);
const endOfExpression = '__dashboard_end_of_expression__';
const expressionOpen = tokenize('(').slice(0, -1);
const expressionClose = tokenize(`) + "${endOfExpression}"`).slice(0, -1);

function completeExpression(tokens: ReturnType<typeof tokenize>) {
  // The streaming parser tolerates trailing tokens. Wrapping the expression
  // makes the closing sentinel unreachable if it stopped parsing early.
  const wrapped = parseExpression([...expressionOpen, ...tokens, ...expressionClose]);
  return wrapped.k === 'BinOp' &&
    wrapped.op === '+' &&
    wrapped.right.k === 'Str' &&
    wrapped.right.v === endOfExpression
    ? wrapped.left
    : undefined;
}

type DashboardQuery = {
  statement: string;
  start: number;
  end: number;
  defaults: unknown;
  refresh?: number | undefined;
} & (
  | { tool: 'query_records'; args: z.infer<typeof dashboardRecordsSchema> }
  | { tool: 'aggregate_records'; args: z.infer<typeof dashboardAggregateSchema> }
);

function literal(node: ASTNode | null | undefined): unknown {
  switch (node?.k) {
    case 'Str':
    case 'Bool':
      return node.v;
    case 'Num':
      if (Number.isFinite(node.v)) return node.v;
      break;
    case 'UnaryOp':
      if (node.op === '-' && node.operand.k === 'Num' && Number.isFinite(node.operand.v))
        return -node.operand.v;
      break;
    case 'Null':
      return null;
    case 'Arr':
      return node.els.map(literal);
    case 'Obj': {
      const keys = node.entries.map(([key]) => key);
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key) => DASHBOARD_FORBIDDEN_KEYS.has(key))
      ) {
        throw new Error('Object keys must be unique, valid names');
      }
      return Object.fromEntries(node.entries.map(([key, value]) => [key, literal(value)]));
    }
  }
  throw new Error('Query arguments, defaults and refresh must be plain values');
}

export function inspectDashboard(program: string, stored = false) {
  const problems: DashboardIssue[] = [];
  const queries: DashboardQuery[] = [];
  let parsed: ParseResult | undefined;
  const report = (statement: string, message: string) => problems.push({ statement, message });
  // Key translation adds bytes. The limit applies to the program the caller supplied.
  if (!stored && Buffer.byteLength(program) > DASHBOARD_MAX_BYTES) {
    report('root', 'Dashboard programs must be at most 20 KB');
    return { problems, queries };
  }
  try {
    const statements = split(tokenize(program));
    const declarations = new Map<string, ASTNode>();
    let at = 0;
    for (const raw of statements) {
      if (program.slice(at, raw.start).trim()) report('root', 'Expected a named statement');
      at = raw.end ?? program.length;
      if (declarations.has(raw.id)) report(raw.id, 'Statement name is defined twice');
      const node = completeExpression(raw.tokens);
      if (!node) {
        report(raw.id, 'Expected one complete expression');
        continue;
      }
      declarations.set(raw.id, node);
      if (node.k !== 'Comp' || node.name !== 'Query') continue;
      try {
        if (node.args.length < 3 || node.args.length > 4)
          throw new Error('Query takes three or four arguments');
        const tool = literal(node.args[0]);
        const args = literal(node.args[1]);
        const defaults = literal(node.args[2]);
        const refresh = node.args[3] && literal(node.args[3]);
        if (refresh !== undefined && !validDashboardRefresh(refresh))
          throw new Error(
            'Query refresh must be at least 60 seconds and fit within the browser timer range',
          );
        const location = { statement: raw.id, start: raw.start ?? 0, end: at, defaults, refresh };
        if (tool === 'query_records') {
          queries.push({ ...location, tool, args: dashboardRecordsSchema.parse(args) });
        } else if (tool === 'aggregate_records') {
          queries.push({ ...location, tool, args: dashboardAggregateSchema.parse(args) });
        } else throw new Error('Query can only call query_records or aggregate_records');
      } catch (error) {
        report(raw.id, error instanceof Error ? error.message : String(error));
      }
    }
    if (program.slice(at).trim()) report('root', 'Expected a named statement');
    if (queries.length > DASHBOARD_MAX_QUERIES)
      report('root', 'A dashboard allows at most 20 queries');

    const root = declarations.get('root');
    if (root?.k !== 'Comp' || root.name !== 'Dashboard')
      report('root', 'Expected root = Dashboard(…)');
    const resolve = (node: ASTNode | undefined): ASTNode | undefined => {
      const seen = new Set<string>();
      while (node?.k === 'Ref' && !seen.has(node.n)) {
        seen.add(node.n);
        node = declarations.get(node.n);
      }
      return node;
    };
    // Table rows may be transformed with built-ins. Follow references to
    // the record queries feeding the expression to find their common keys.
    function recordSources(node: ASTNode, seen = new Set<string>()): DashboardQuery[] {
      const sources: DashboardQuery[] = [];
      walkAST(node, (part) => {
        if (part.k !== 'Ref' || seen.has(part.n)) return;
        seen.add(part.n);
        const query = queries.find(({ statement }) => statement === part.n);
        if (query) sources.push(query);
        else {
          const declaration = declarations.get(part.n);
          if (declaration) sources.push(...recordSources(declaration, seen));
        }
      });
      return sources;
    }
    const references = new Map<string, Set<string>>();
    for (const [id, node] of declarations) {
      const dependencies = new Set<string>();
      references.set(id, dependencies);
      if (id.startsWith('$') || DASHBOARD_FORBIDDEN_KEYS.has(id))
        report(id, 'Invalid statement name');
      walkAST(node, (part) => {
        if (part.k === 'Ref') {
          if (declarations.has(part.n)) dependencies.add(part.n);
          else report(id, `"${part.n}" is used but never defined`);
        }
        if (part.k === 'StateRef' || part.k === 'Assign')
          report(id, 'Dashboards only support reads');
        const member =
          part.k === 'Member'
            ? part.field
            : part.k === 'Index' && part.index.k === 'Str'
              ? part.index.v
              : undefined;
        if (member && DASHBOARD_FORBIDDEN_KEYS.has(member)) report(id, 'Invalid property name');
        if (part.k === 'Obj' && part.entries.some(([key]) => DASHBOARD_FORBIDDEN_KEYS.has(key)))
          report(id, 'Invalid property name');
        if (part.k !== 'Comp') return;
        if (part.name === 'Query') {
          if (part !== node) report(id, 'Query must be its own statement');
          return;
        }
        if (valueFunctions.has(part.name)) return;
        const definition = Object.hasOwn(dashboardLibrary.components, part.name)
          ? dashboardLibrary.components[part.name]
          : undefined;
        if (!definition || part.fn) {
          report(id, `Unknown dashboard component or function "${part.name}"`);
          return;
        }
        const props = Object.entries(definition.props.shape) as [string, z.ZodType][];
        if (part.args.length > props.length) report(id, `Too many properties for ${part.name}`);
        for (const [index, [prop, schema]] of props.entries()) {
          const arg = part.args[index];
          let value: unknown;
          if (arg) {
            try {
              value = literal(arg);
            } catch {
              continue;
            }
          }
          if (!schema.safeParse(value).success) report(id, `Invalid "${prop}" on ${part.name}`);
        }
        if (part.name !== 'Table') return;
        const rows = part.args[1];
        const sources = rows ? recordSources(rows) : [];
        const columns = resolve(part.args[2]);
        if (columns?.k !== 'Arr') {
          report(id, 'Table columns must be a list of TableColumn components');
          return;
        }
        for (const item of columns.els) {
          const column = resolve(item);
          const key =
            column?.k === 'Comp' && column.name === 'TableColumn'
              ? resolve(column.args[1])
              : undefined;
          if (
            key?.k !== 'Str' ||
            (key.v !== 'id' &&
              key.v !== 'label' &&
              (!sources.length ||
                sources.some(
                  (source) =>
                    source.tool !== 'query_records' || !Object.hasOwn(source.args.fields, key.v),
                )))
          )
            report(id, 'A table column must use id, label or a field alias from its query');
        }
      });
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    function validateReferences(id: string): void {
      if (visiting.has(id)) {
        report(id, 'Circular statement reference');
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of references.get(id) ?? []) validateReferences(dependency);
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of references.keys()) validateReferences(id);

    parsed = parser.parse(program);
    if (parsed.meta.incomplete) report('root', 'Dashboard program is incomplete');
    for (const error of parsed.meta.errors) report(error.statementId ?? 'root', error.message);
    for (const name of parsed.meta.unresolved)
      report('root', `"${name}" is used but never defined`);
  } catch {
    report('root', 'Dashboard program could not be parsed');
  }
  return {
    problems: problems.filter(
      (issue, index) =>
        problems.findIndex(
          (entry) => entry.message === issue.message && entry.statement === issue.statement,
        ) === index,
    ),
    queries,
    parsed,
  };
}

export function rewriteQueries(
  program: string,
  queries: DashboardQuery[],
  argsFor: (query: DashboardQuery) => unknown,
): string {
  let at = 0;
  const parts: string[] = [];
  for (const query of queries) {
    parts.push(program.slice(at, query.start));
    const refresh = query.refresh === undefined ? '' : `, ${query.refresh}`;
    parts.push(
      `${query.statement} = Query(${JSON.stringify(query.tool)}, ${JSON.stringify(argsFor(query))}, ${JSON.stringify(query.defaults)}${refresh})`,
    );
    at = query.end;
  }
  parts.push(program.slice(at));
  return parts.join('');
}
