import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../../src/db/migrate.js';
import { assertCompletedRun, classifyReport } from './report.js';

// These test migration/upgrade machinery itself, rather than an old running
// server. They explicitly migrate or rewrite historical schema/data.
const excluded = JSON.parse(
  readFileSync(
    new URL('../../../../scripts/migration-compatibility-exclusions.json', import.meta.url),
    'utf8',
  ),
) as string[];
const base = resolve(process.argv[2] ?? '');
const output = resolve(process.argv[3] ?? 'test-results/migration-compatibility');
mkdirSync(output, { recursive: true });
const verdict: Record<string, unknown> = {
  version: 1,
  verdict: 'error',
  baseSha: process.env.BASE_SHA,
  headSha: process.env.HEAD_SHA,
  excluded,
  failingTests: [],
};
const adminUrl = process.env.DATABASE_URL;
const template = `retainer_compat_${randomBytes(8).toString('hex')}`;

function command(args: string[], env = {}) {
  const result = spawnSync('pnpm', args, {
    cwd: base,
    env: { ...process.env, CI: 'true', ...env },
    stdio: 'inherit',
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`Could not run ${args.join(' ')}: ${result.error ?? result.signal}`);
  }
  return result.status;
}

function test(phase: string, suppliedTemplate?: string) {
  const file = resolve(output, `${phase}.json`);
  const runtimeFile = resolve(output, `${phase}-runtime.json`);
  const status = command(
    [
      '--filter',
      '@retainer/server',
      'exec',
      'vitest',
      'run',
      '--project',
      'integration',
      '--maxWorkers',
      '4',
      '--reporter=default',
      '--reporter=json',
      `--reporter=${resolve('../../scripts/migration-compatibility-reporter.mjs')}`,
      `--outputFile.json=${file}`,
      ...excluded.flatMap((path) => ['--exclude', path]),
    ],
    { RETAINER_TEST_TEMPLATE: suppliedTemplate ?? '', RETAINER_COMPAT_RUNTIME_REPORT: runtimeFile },
  );
  const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  assertCompletedRun(runtime, phase);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  return classifyReport(report, status, phase, base);
}

let admin: ReturnType<typeof postgres> | undefined;
try {
  if (!process.argv[2] || !adminUrl) throw new Error('Provide base checkout and DATABASE_URL');
  // Bootstrap old branches which predate the hook. No test or product code
  // is copied from the PR: only the template lifecycle adapter.
  copyFileSync('test/global-setup.ts', resolve(base, 'packages/server/test/global-setup.ts'));
  const baseline = test('baseline');
  if (baseline.length) throw new Error('Base tests fail on base schema; compatibility is unknown.');
  admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  if (
    command(['--filter', '@retainer/server', 'exec', 'tsx', 'src/db/migrate.ts'], {
      DATABASE_URL: url.toString(),
    }) !== 0
  )
    throw new Error('Could not prepare base schema');
  await runMigrations(url.toString());
  const failures = test('candidate', template);
  verdict.failingTests = failures;
  verdict.verdict = failures.length ? 'breaking' : 'not breaking';
} catch (error) {
  verdict.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (admin) await admin.unsafe(`drop database if exists "${template}" with (force)`);
  } catch (error) {
    verdict.verdict = 'error';
    verdict.error = `Cleanup failed: ${String(error)}`;
    process.exitCode = 1;
  } finally {
    await admin?.end();
  }
  writeFileSync(resolve(output, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`Migration compatibility: ${verdict.verdict}`);
}
