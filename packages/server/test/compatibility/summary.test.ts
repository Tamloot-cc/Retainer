import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('publishes a complete error artifact when setup never produced a verdict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retainer-compat-summary-'));
  const scripts = new URL('../../../../scripts/', import.meta.url);
  try {
    const summary = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('migration-compatibility-summary.mjs', scripts))],
      {
        env: {
          ...process.env,
          RESULT_DIR: directory,
          BASE_SHA: 'base',
          HEAD_SHA: 'head',
          GITHUB_STEP_SUMMARY: '',
        },
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(readFileSync(join(directory, 'verdict.json'), 'utf8'))).toEqual({
      version: 1,
      verdict: 'error',
      baseSha: 'base',
      headSha: 'head',
      excluded: JSON.parse(
        readFileSync(new URL('migration-compatibility-exclusions.json', scripts), 'utf8'),
      ),
      failingTests: [],
      error: 'The job could not finish setup or run the compatibility checker.',
    });
    expect(summary).toContain('Migration compatibility: error');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
