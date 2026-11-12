#!/usr/bin/env node
// Keeps the server's modules layered and the MIT packages free of server code.
// ARCHITECTURE.md section 8 describes the layers. Runs as part of `pnpm lint`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'packages/server/src');
const MIT_PACKAGES = readdirSync(join(ROOT, 'packages')).filter(
  (dir) =>
    JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')).license === 'MIT',
);

// Lowest first. A module may import its own layer and the layers before it.
const LAYERS = [
  [
    'foundation',
    [
      'caller',
      'config',
      'errors',
      'log',
      'version',
      'stable-json',
      'idempotency',
      'db',
      'schema',
      'extension-runtime',
      'file-storage',
    ],
  ],
  ['core', ['records', 'memory', 'privacy', 'files', 'sources', 'changes']],
  ['features', ['views', 'comments', 'retrieval', 'reads']],
  ['admin', ['schema-engine', 'templates', 'workspaces', 'extensions']],
  [
    'interfaces',
    [
      'http',
      'auth',
      'api',
      'mcp',
      'worker',
      'operator',
      'accounts',
      'egress',
      'launcher',
      'extension-control',
      'webhooks',
    ],
  ],
  ['entry', ['index', 'cli', 'lambda', 'egress-proxy', 'extension-launcher', 'file-server']],
];
// Events are records, so these modules depend on each other by design.
const MAY_SHARE_A_CYCLE = 'core';
/** The only files that load the accounts module, and with it Better Auth. */
const ACCOUNTS_ENTRIES = ['packages/server/src/index.ts', 'packages/server/src/lambda/control.ts'];

const layerOf = new Map(LAYERS.flatMap(([, modules], i) => modules.map((m) => [m, i])));
const layerName = (module) => LAYERS[layerOf.get(module)][0];

/** ARCHITECTURE.md lists the layers highest first; they must match LAYERS, in order. */
function documentationProblems() {
  const doc = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  const blocks = doc.slice(doc.indexOf('### Server layers')).split('\n\n');
  const rows = (blocks.find((block) => block.startsWith('|')) ?? '').split('\n').slice(2);
  const documented = rows.map((row) => {
    const [, layer, modules] = row.split('|');
    const names = [...modules.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    return [layer.trim().toLowerCase(), names.toSorted()];
  });
  const expected = LAYERS.map(([name, modules]) => [name, modules.toSorted()]).reverse();
  return JSON.stringify(documented) === JSON.stringify(expected)
    ? []
    : [`ARCHITECTURE.md's layer table doesn't match LAYERS in scripts/check-layers.mjs`];
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const importsOf = (file) =>
  [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1]);

function resolve(file, specifier) {
  const base = normalize(join(dirname(file), specifier)).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`].find(existsSync);
}

/** The module of a server file: its top folder, or its name for a top-level file. */
function moduleOf(file) {
  return relative(SERVER, file)
    .split('/')[0]
    .replace(/\.tsx?$/, '');
}

/** Strongly connected components with more than one node (Tarjan). */
function cycles(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const found = [];
  const visit = (node) => {
    index.set(node, index.size);
    low.set(node, index.get(node));
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (stack.includes(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = stack.splice(stack.indexOf(node));
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

const problems = documentationProblems();
const fileGraph = new Map();
const moduleGraph = new Map();
const edge = (graph, from, to) => {
  if (!graph.has(from)) graph.set(from, new Set());
  graph.get(from).add(to);
};

for (const file of sourceFiles(SERVER)) {
  const from = moduleOf(file);
  const name = relative(ROOT, file);
  if (!layerOf.has(from)) {
    problems.push(`${name}: module "${from}" has no layer in scripts/check-layers.mjs`);
    continue;
  }
  fileGraph.set(file, new Set());
  for (const specifier of importsOf(file)) {
    // Better Auth runs only where people sign in (accounts spec 4.13).
    if (/^(better-auth|@better-auth\/)/.test(specifier) && from !== 'accounts') {
      problems.push(`${name}: only the accounts module may import ${specifier}`);
    }
    if (!specifier.startsWith('.')) continue;
    const target = resolve(file, specifier);
    if (!target?.startsWith(SERVER)) continue;
    edge(fileGraph, file, target);
    const to = moduleOf(target);
    // The API never loads Better Auth: only the container entry and the
    // control function reach the accounts module.
    if (to === 'accounts' && from !== 'accounts' && !ACCOUNTS_ENTRIES.includes(name)) {
      problems.push(`${name}: only ${ACCOUNTS_ENTRIES.join(' and ')} may import accounts`);
    }
    if (to === from) continue;
    if (layerOf.get(to) > layerOf.get(from)) {
      problems.push(
        `${name}: ${from} (${layerName(from)}) must not import ${to} (${layerName(to)})`,
      );
    }
    // A cycle across layers needs an upward import, which is reported above.
    if (layerOf.get(from) === layerOf.get(to) && layerName(from) !== MAY_SHARE_A_CYCLE) {
      edge(moduleGraph, from, to);
    }
  }
}

for (const cycle of cycles(moduleGraph)) problems.push(`module cycle: ${cycle.join(', ')}`);
for (const cycle of cycles(fileGraph)) {
  problems.push(`file cycle: ${cycle.map((file) => relative(SERVER, file)).join(', ')}`);
}

for (const pkg of MIT_PACKAGES) {
  for (const file of sourceFiles(join(ROOT, 'packages', pkg, 'src'))) {
    for (const specifier of importsOf(file)) {
      const absolute = normalize(join(dirname(file), specifier));
      if (
        specifier.startsWith('@retainer/server') ||
        absolute.startsWith(join(ROOT, 'packages/server'))
      ) {
        problems.push(
          `${relative(ROOT, file)}: MIT package imports AGPL server code (${specifier})`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Layer check failed:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Layer check passed: ${fileGraph.size} server files.`);
