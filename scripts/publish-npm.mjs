#!/usr/bin/env node
// Publishes every workspace package that is not `private` to npm. pnpm packs
// each one, which turns `workspace:*` dependencies into real versions, and npm
// publishes the tarball. In GitHub Actions npm signs in through trusted
// publishing (OIDC) and adds provenance, so no token is needed. A version that
// is already on npm is skipped, so a release can be re-run after a partial
// publish, or after packages were published by hand. Run `pnpm build` first.
//
//   node scripts/publish-npm.mjs            publish
//   node scripts/publish-npm.mjs --dry-run  pack and check, publish nothing
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = new URL('../', import.meta.url);
const out = mkdtempSync(join(tmpdir(), 'retainer-npm-'));
const run = (cmd, args, { cwd, quiet } = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  });

const all = readdirSync(new URL('packages/', root))
  .map((dir) => ({
    dir,
    ...JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, root), 'utf8')),
  }))
  .filter((pkg) => !pkg.private);

// Dependencies first, so a package never points at a version that is not out yet.
const byName = new Map(all.map((pkg) => [pkg.name, pkg]));
const packages = [];
const visit = (pkg) => {
  if (packages.includes(pkg)) return;
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (byName.has(dep)) visit(byName.get(dep));
  }
  packages.push(pkg);
};
for (const pkg of all) visit(pkg);

function published(name, version) {
  try {
    return (
      run('npm', ['view', `${name}@${version}`, 'version'], { quiet: true }).trim() === version
    );
  } catch {
    return false; // npm view exits non-zero for a package that does not exist yet.
  }
}

for (const pkg of packages) {
  const id = `${pkg.name}@${pkg.version}`;
  if (published(pkg.name, pkg.version)) {
    console.log(`${id} is already on npm; skipped.`);
    continue;
  }
  const cwd = new URL(`packages/${pkg.dir}/`, root).pathname;
  const tarball = run('pnpm', ['pack', '--pack-destination', out], { cwd })
    .trim()
    .split('\n')
    .pop();
  const args = ['publish', tarball, '--access', 'public'];
  // npm refuses a pre-release without a dist-tag; keep it off `latest`.
  if (pkg.version.includes('-')) args.push('--tag', 'next');
  if (dryRun) args.push('--dry-run');
  run('npm', args, { cwd });
  console.log(`${id} ${dryRun ? 'packed (dry run)' : 'published'}.`);
}
