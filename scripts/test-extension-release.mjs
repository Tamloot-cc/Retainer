import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
