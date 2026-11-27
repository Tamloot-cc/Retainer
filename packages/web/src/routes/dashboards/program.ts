import {
  type ASTNode,
  mergeStatements,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import {
  DASHBOARD_MAX_BYTES,
  DASHBOARD_MAX_QUERIES,
  type DashboardIssue,
  validDashboardRefresh,
} from '@retainer/shared';

function statements(program: string) {
  return split(tokenize(program));
}

export function programTitle(program: string): string {
  try {
    const root = statements(program).find(({ id }) => id === 'root');
    const node = root && parseExpression(root.tokens);
    if (node?.k === 'Comp' && node.name === 'Dashboard' && node.args[0]?.k === 'Str')
      return node.args[0].v.trim().slice(0, 100) || 'Dashboard';
  } catch {
    // The preview reports errors while the person is looking at the draft.
  }
  return 'Dashboard';
}

// Saving normalizes Query arguments. Compare statements and object keys
// independent of their formatting when restoring the Saved badge in chat.
export function sameDashboardProgram(first: string, second: string): boolean {
  if (first === second) return true;
  const normalize = (source: string) =>
    JSON.stringify(
      statements(source)
        .map(({ id, tokens }) => ({ id, expression: parseExpression(tokens) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      (_key, node: unknown) => {
        if (node === null || typeof node !== 'object' || !('k' in node) || node.k !== 'Obj')
          return node;
        const object = node as Extract<ASTNode, { k: 'Obj' }>;
        return { ...object, entries: object.entries.toSorted(([a], [b]) => a.localeCompare(b)) };
      },
    );
  try {
    return normalize(first) === normalize(second);
  } catch {
    return false;
  }
}

export function mergeDashboardBlocks(previous: string[], current: string): string {
  let program = '';
  for (const block of [...previous, current]) {
    if (!block.trim()) continue;
    program = program ? mergeStatements(program, block) : block.trim();
  }
  return program;
}

export function matchesDashboardHistory(blocks: string[], program: string): boolean {
  try {
    return sameDashboardProgram(mergeDashboardBlocks(blocks, ''), program);
  } catch {
    return false;
  }
}

function isLiteral(node: ASTNode | undefined): boolean {
  switch (node?.k) {
    case 'Str':
    case 'Bool':
    case 'Null':
      return true;
    case 'Num':
      return Number.isFinite(node.v);
    case 'UnaryOp':
      return node.op === '-' && node.operand.k === 'Num' && Number.isFinite(node.operand.v);
    case 'Arr':
      return node.els.every(isLiteral);
    case 'Obj':
      return node.entries.every(
        ([key, value]) =>
          !['__proto__', 'constructor', 'prototype'].includes(key) && isLiteral(value),
      );
    default:
      return false;
  }
}

/** Enforce read and refresh limits on drafts as well as saved programs. */
export function renderableProgram(
  program: string,
  savedIssues: DashboardIssue[],
  { saved = false, live = true } = {},
) {
  const issues = [...savedIssues];
  if (!saved && new TextEncoder().encode(program).length > DASHBOARD_MAX_BYTES)
    return {
      program: '',
      issues: [{ statement: 'root', message: 'This dashboard exceeds 20 KB' }],
    };
  let at = 0;
  let count = 0;
  const out: string[] = [];
  for (const { start = 0, end = program.length, id, tokens } of statements(program)) {
    const node = parseExpression(tokens);
    let nestedQuery = false;
    walkAST(node, (part) => {
      if (part !== node && part.k === 'Comp' && part.name === 'Query') nestedQuery = true;
    });
    if (nestedQuery)
      return {
        program: '',
        issues: [...issues, { statement: id, message: 'Query must be its own statement' }],
      };
    if (node.k !== 'Comp' || node.name !== 'Query') continue;
    if (!live) {
      out.push(program.slice(at, start), `${id} = null`);
      at = end;
      continue;
    }
    count++;
    const [tool, args, defaults, refresh] = node.args;
    const valid =
      count <= DASHBOARD_MAX_QUERIES &&
      node.args.length <= 4 &&
      tool?.k === 'Str' &&
      (tool.v === 'query_records' || tool.v === 'aggregate_records') &&
      args?.k === 'Obj' &&
      isLiteral(args) &&
      isLiteral(defaults) &&
      (!refresh || (refresh.k === 'Num' && validDashboardRefresh(refresh.v)));
    const existingIssue = savedIssues.some((issue) => issue.statement === id);
    if (valid && !existingIssue) continue;
    if (!existingIssue)
      issues.push({
        statement: id,
        message: 'This query exceeds dashboard limits or has invalid arguments',
      });
    // Leave a query-shaped source so the affected tile can show the issue.
    out.push(program.slice(at, start), `${id} = Query("__unavailable", {}, {})`);
    at = end;
  }
  out.push(program.slice(at));
  return { program: out.join(''), issues };
}
