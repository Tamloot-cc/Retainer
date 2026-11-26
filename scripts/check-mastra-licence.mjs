#!/usr/bin/env node
// Keeps the workspace agent on Mastra's Apache-2.0 code (docs/specs/agent.md
// §3.3). Everything in Mastra is Apache-2.0 except code from folders named
// `ee/`, under the Mastra Enterprise Edition License. The agent loads none of
// those features, but @mastra/core bundles a few `ee/` functions into the
// modules the agent loads (the agent loop calls `requireFGA` on every tool
// call; with no FGA provider it returns at once).
//
// This check walks the import graph of every Mastra module Retainer loads,
// lists the Enterprise-licensed bindings those modules import, and fails if
// that list grows beyond the recorded baseline, or if a Mastra licence file
// changes. Run it on every Mastra upgrade (`pnpm check:mastra-licence`) and
// update the baseline only after reading what changed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts/mastra-licence-baseline.json');
const AGENT = join(ROOT, 'packages/agent');

/** Every Mastra entry point packages/agent and the server import. */
const ENTRIES = [
  '@mastra/core/agent',
  '@mastra/core/logger',
  '@mastra/core/memory',
  '@mastra/core/request-context',
  '@mastra/core/storage',
  '@mastra/core/tools',
  '@mastra/memory',
  '@mastra/ai-sdk',
  '@mastra/ai-sdk/ui',
  '@mastra/pg',
];

const requireFrom = (dir) => createRequire(join(dir, 'package.json'));

/** The ESM file a bare specifier resolves to, from a given directory. */
function resolveBare(specifier, fromDir) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = `.${specifier.slice(name.length)}` || '.';
  let pkgJsonPath;
  try {
    pkgJsonPath = requireFrom(fromDir).resolve(`${name}/package.json`);
  } catch {
    return undefined;
  }
  const pkgDir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  let target =
    pkg.exports?.[subpath === '.' ? '.' : subpath] ?? (subpath === '.' ? pkg.main : undefined);
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return undefined;
    return pick(value.import) ?? pick(value.default) ?? pick(value.node);
  };
  target = pick(target);
  if (!target) return undefined;
  return { file: realpathSync(join(pkgDir, target)), pkgDir: realpathSync(pkgDir), name };
}

const IMPORT = /(?:^|[;\n])\s*(?:import|export)\s*(?:([^'";]*?)\s*from\s*)?['"]([^'"]+)['"]/g;

const isEnterprise = (source) =>
  source.includes('@license Mastra Enterprise License') || /\/\/ [^\n]*\/ee\//.test(source);

/** Maps an Enterprise chunk's export aliases back to the names it defines. */
function exportNames(source) {
  const names = new Map();
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of match[1].split(',')) {
      const [local, alias] = item.trim().split(/\s+as\s+/);
      if (local) names.set((alias ?? local).trim(), local.trim());
    }
  }
  return names;
}

const seen = new Set();
const enterpriseBindings = new Set();
const enterpriseFiles = new Set();
const licenceFiles = new Set();
const queue = [];

for (const entry of ENTRIES) {
  const resolved = resolveBare(entry, AGENT);
  if (!resolved) throw new Error(`cannot resolve ${entry} from packages/agent`);
  queue.push(resolved.file);
  for (const name of ['LICENSE.md', 'LICENSE', 'ee/LICENSE']) {
    const path = join(resolved.pkgDir, name);
    if (existsSync(path)) licenceFiles.add(path);
  }
}

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  if (isEnterprise(source)) enterpriseFiles.add(file);
  for (const match of source.matchAll(IMPORT)) {
    const [, clause, specifier] = match;
    let target;
    if (specifier.startsWith('.')) {
      const path = resolve(dirname(file), specifier);
      if (existsSync(path)) target = realpathSync(path);
    } else if (specifier.startsWith('@mastra/')) {
      target = resolveBare(specifier, dirname(file))?.file;
      const pkg = target && resolveBare(specifier, dirname(file));
      if (pkg) {
        for (const name of ['LICENSE.md', 'LICENSE', 'ee/LICENSE']) {
          const path = join(pkg.pkgDir, name);
          if (existsSync(path)) licenceFiles.add(path);
        }
      }
    }
    if (!target) continue;
    const targetSource = readFileSync(target, 'utf8');
    if (isEnterprise(targetSource) && clause) {
      const names = exportNames(targetSource);
      const braces = clause.match(/\{([^}]*)\}/);
      if (braces) {
        for (const item of braces[1].split(',')) {
          const imported = item
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim();
          if (imported) enterpriseBindings.add(names.get(imported) ?? imported);
        }
      } else {
        enterpriseBindings.add(`* from ${target.split('/').at(-1)}`);
      }
    }
    queue.push(target);
  }
}

const licences = Object.fromEntries(
  [...licenceFiles]
    .map((path) => {
      const pkgJson = JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8'));
      return [
        `${pkgJson.name}/${path.split('/').at(-1)}`,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b)),
);
const current = { enterpriseBindings: [...enterpriseBindings].sort(), licences };

if (process.argv.includes('--write')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];
const allowed = new Set(baseline.enterpriseBindings);
for (const name of current.enterpriseBindings) {
  if (!allowed.has(name)) problems.push(`new Enterprise-licensed import reached: ${name}`);
}
for (const [file, hash] of Object.entries(current.licences)) {
  if (baseline.licences[file] !== hash) problems.push(`licence file changed or new: ${file}`);
}
for (const file of Object.keys(baseline.licences)) {
  if (!(file in current.licences)) problems.push(`licence file gone: ${file}`);
}
if (problems.length) {
  console.error(
    'Mastra licence check failed (docs/specs/agent.md §3.3). Read what changed before updating the baseline with --write:',
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `Mastra licence check passed: ${seen.size} modules, Enterprise imports: ${current.enterpriseBindings.join(', ') || 'none'}.`,
);
