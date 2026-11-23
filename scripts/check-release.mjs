#!/usr/bin/env node
// Checks that every workspace package has the same version and, given a tag
// (`v0.1.0`), that it matches the tag; that every package that would be
// published (not `private`) is MIT and names this repository; and that
// CHANGELOG.md covers the version. In GitHub Actions it also writes `version`
// to the step outputs. Used by the release workflow and
// `pnpm release:check [tag]`.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const packages = readdirSync(new URL('packages/', root)).map((dir) => ({
  path: `packages/${dir}/package.json`,
  ...JSON.parse(read(`packages/${dir}/package.json`)),
}));
const problems = [];

const tag = process.argv[2]?.replace(/^refs\/tags\//, '').replace(/^v/, '');
const version = tag ?? packages[0]?.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  problems.push(`not a semver version: ${version}`);
}
for (const pkg of packages) {
  if (pkg.version !== version) problems.push(`${pkg.path} is ${pkg.version}, expected ${version}`);
  if (!pkg.private && pkg.license !== 'MIT') {
    problems.push(`${pkg.name} would be published but is ${pkg.license}, not MIT`);
  }
  // npm rejects a provenance publish whose repository doesn't match the workflow's.
  const repo = 'git+https://github.com/Tamloot-cc/Retainer.git';
  const dir = pkg.path.replace(/\/package\.json$/, '');
  if (!pkg.private && (pkg.repository?.url !== repo || pkg.repository?.directory !== dir)) {
    problems.push(
      `${pkg.name} would be published but its repository is not ${repo} (directory ${dir})`,
    );
  }
}
// The whole heading line, as the release workflow extracts the notes by it.
if (
  !read('CHANGELOG.md')
    .split('\n')
    .some((line) => line.trimEnd() === `## ${version}`)
) {
  problems.push(`CHANGELOG.md has no "## ${version}" section`);
}

if (problems.length) {
  console.error(`Release check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
const published = packages.filter((pkg) => !pkg.private).map((pkg) => pkg.name);
console.log(`Release check passed for ${version}; publishes ${published.join(', ')}.`);
