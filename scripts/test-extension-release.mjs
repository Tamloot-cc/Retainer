import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extensionRelease, extensionServerRange } from './extension-release.mjs';

test('accepts clean detached main commits and never reuses a published version after main advances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retainer-release-policy-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release fixture');
    git('config', 'user.email', 'release@example.test');
    git('commit', '--allow-empty', '-m', 'First main commit');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '--detach', 'HEAD');
    const first = extensionRelease(git, false);
    assert.equal(first.version, '1.0.1');
    git('checkout', 'main');
    git('commit', '--allow-empty', '-m', 'Next main commit');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const second = extensionRelease(git, false);
    assert.equal(second.version, '1.0.2');
    assert.notEqual(first.commit, second.commit);
    git('checkout', '-b', 'feature');
    git('commit', '--allow-empty', '-m', 'Unreviewed feature');
    assert.throws(() => extensionRelease(git, false), /on origin\/main/);
    assert.equal(extensionRelease(git, true).development, true);
    git('checkout', 'main');
    writeFileSync(join(directory, 'untracked-content'), 'dirty');
    assert.throws(() => extensionRelease(git, false), /clean main commit/);
    assert.equal(extensionRelease(git, true).version, '1.0.0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires reviewed server compatibility and does not silently claim support after a version bump', () => {
  assert.equal(extensionServerRange('0.1.0'), '>=0.1.0 <0.2.0');
  // A server patch inside the reviewed range needs no new release.
  assert.equal(extensionServerRange('0.1.7'), '>=0.1.0 <0.2.0');
  assert.throws(() => extensionServerRange('0.2.0'), /compatibility must be reviewed/);
  assert.throws(() => extensionServerRange('0.1.0', '>=0.1.0'), /upper bound/);
});

test('real artifact builds reuse content across unrelated commits but detect a rebuilt runner source change', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'retainer-content-release-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    writeFileSync(join(directory, '.gitignore'), 'node_modules/\nartifacts/\n*.tsbuildinfo\n');
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    cpSync(join(root, 'tsconfig.base.json'), join(directory, 'tsconfig.base.json'));
    cpSync(join(root, 'pnpm-lock.yaml'), join(directory, 'pnpm-lock.yaml'));
    for (const pkg of ['shared', 'extension', 'sdk', 'runner', 'server']) {
      const target = join(directory, 'packages', pkg);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, 'packages', pkg, 'package.json'), join(target, 'package.json'));
      if (pkg === 'server') {
        mkdirSync(join(target, 'dist'));
        cpSync(
          join(root, 'packages/server/dist/stable-json.js'),
          join(target, 'dist/stable-json.js'),
        );
      } else cpSync(join(root, 'packages', pkg, 'dist'), join(target, 'dist'), { recursive: true });
      symlinkSync(join(root, 'packages', pkg, 'node_modules'), join(target, 'node_modules'), 'dir');
    }
    cpSync(join(root, 'packages/runner/src'), join(directory, 'packages/runner/src'), {
      recursive: true,
    });
    cpSync(
      join(root, 'packages/runner/tsconfig.json'),
      join(directory, 'packages/runner/tsconfig.json'),
    );
    mkdirSync(join(directory, 'scripts'));
    for (const script of ['build-extension-artifacts.mjs', 'extension-release.mjs'])
      cpSync(join(root, 'scripts', script), join(directory, 'scripts', script));
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Content fixture');
    git('config', 'user.email', 'release@example.test');
    const commit = () => {
      git('add', '.');
      git('commit', '-m', 'Release fixture');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    };
    const build = () => {
      execFileSync(process.execPath, ['scripts/build-extension-artifacts.mjs'], {
        cwd: directory,
        stdio: 'pipe',
      });
      return ['fixture', 'last-contact', 'granola'].map((bundle) =>
        JSON.parse(
          readFileSync(join(directory, 'artifacts/extensions', bundle, 'metadata.json'), 'utf8'),
        ),
      );
    };
    commit();
    const first = build();
    writeFileSync(join(directory, 'unrelated-doc.md'), 'No runner inputs changed.');
    commit();
    const second = build();
    for (let i = 0; i < first.length; i++) {
      assert.match(first[i].contentDigest, /^[a-f0-9]{64}$/);
      assert.equal(first[i].contentDigest, second[i].contentDigest);
      assert.notEqual(first[i].version, second[i].version);
      assert.notEqual(first[i].releaseDigest, second[i].releaseDigest);
    }
    appendFileSync(
      join(directory, 'packages/runner/src/registry.ts'),
      '\n// A reviewed change to runner code.\n',
    );
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'packages/runner/tsconfig.json'], {
      cwd: directory,
      stdio: 'pipe',
    });
    commit();
    const third = build();
    for (let i = 0; i < first.length; i++)
      assert.notEqual(second[i].contentDigest, third[i].contentDigest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
