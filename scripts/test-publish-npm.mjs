// The npm publish step of the release workflow (docs/releasing.md): public
// packages go out in dependency order, versions already on npm are skipped,
// pre-releases get the `next` tag, and a failed publish stops the run. npm
// and pnpm are replaced by stubs that log their calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// `npm view <name>@<version> version` succeeds only for ids listed in
// $PUBLISHED; `npm publish` of a tarball named in $FAIL fails.
const NPM = `#!/bin/sh
echo "npm $*" >> "$LOG"
case "$1" in
  view) grep -qxF "$2" "$PUBLISHED" && echo "\${2##*@}" && exit 0; exit 1 ;;
  publish) [ -n "$FAIL" ] && case "$2" in *"$FAIL"*) exit 1 ;; esac; exit 0 ;;
esac
`;
// `pnpm pack --pack-destination <dir>` prints the tarball path it wrote.
const PNPM = `#!/bin/sh
echo "pnpm $*" >> "$LOG"
echo "$3/$(basename "$PWD").tgz"
`;

/**
 * Runs the script against a fixture repository of `packages`
 * ({ dir: package.json }) with `published` ids already on npm.
 */
function publish(packages, { published = [], args = [], fail } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retainer-publish-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const [name, body] of [
      ['npm', NPM],
      ['pnpm', PNPM],
    ]) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    for (const [dir, pkg] of Object.entries(packages)) {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(pkg));
    }
    writeFileSync(join(root, 'published'), published.map((id) => `${id}\n`).join(''));
    writeFileSync(join(root, 'log'), '');
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/publish-npm.mjs'), ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RETAINER_PUBLISH_ROOT: root,
        LOG: join(root, 'log'),
        PUBLISHED: join(root, 'published'),
        FAIL: fail ?? '',
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(join(root, 'log'), 'utf8').trim().split('\n').filter(Boolean);
    const published_ = calls
      .filter((call) => call.startsWith('npm publish'))
      .map((call) => call.split(' ')[2].split('/').pop());
    return { ...result, calls, publishes: published_ };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const workspace = {
  // Listed out of order on purpose: cli needs sdk, which needs shared.
  cli: { name: '@r/cli', version: '1.0.0', dependencies: { '@r/sdk': 'workspace:*' } },
  sdk: { name: '@r/sdk', version: '1.0.0', dependencies: { '@r/shared': 'workspace:*' } },
  server: { name: '@r/server', version: '1.0.0', private: true },
  shared: { name: '@r/shared', version: '1.0.0', dependencies: { zod: '^4' } },
};

test('publishes public packages in dependency order and leaves private ones out', () => {
  const result = publish(workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publishes, ['shared.tgz', 'sdk.tgz', 'cli.tgz']);
  const shared = result.calls.find((call) => call.includes('publish') && call.includes('shared'));
  assert.match(shared, / --access public$/);
});

test('skips versions already on npm, so a failed release can be re-run', () => {
  const result = publish(workspace, { published: ['@r/shared@1.0.0', '@r/sdk@1.0.0'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publishes, ['cli.tgz']);
  assert.match(result.stdout, /@r\/shared@1\.0\.0 is already on npm; skipped\./);
  assert.match(result.stdout, /@r\/cli@1\.0\.0 published\./);
});

test('a pre-release goes to the next tag, not latest', () => {
  const result = publish({ shared: { name: '@r/shared', version: '2.0.0-rc.1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.calls.some((call) => call.startsWith('npm publish') && / --tag next/.test(call)),
  );
  const release = publish({ shared: { name: '@r/shared', version: '2.0.0' } });
  assert.ok(!release.calls.some((call) => call.includes('--tag')));
});

test('a dry run passes --dry-run to every publish', () => {
  const result = publish(workspace, { args: ['--dry-run'] });
  assert.equal(result.status, 0, result.stderr);
  const publishes = result.calls.filter((call) => call.startsWith('npm publish'));
  assert.equal(publishes.length, 3);
  assert.ok(publishes.every((call) => call.endsWith(' --dry-run')));
  assert.match(result.stdout, /packed \(dry run\)/);
});

test('a failed publish stops before the packages that depend on it', () => {
  const result = publish(workspace, { fail: 'sdk' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.publishes, ['shared.tgz', 'sdk.tgz']);
  assert.ok(!result.calls.some((call) => call.includes('cli.tgz')));
});
