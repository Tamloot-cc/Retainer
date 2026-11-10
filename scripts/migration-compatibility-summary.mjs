import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.env.RESULT_DIR ?? 'test-results/migration-compatibility');
mkdirSync(dir, { recursive: true });
const path = resolve(dir, 'verdict.json');
if (!existsSync(path)) {
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        verdict: 'error',
        baseSha: process.env.BASE_SHA,
        headSha: process.env.HEAD_SHA,
        error: 'The job could not finish setup or run the compatibility checker.',
        failingTests: [],
      },
      null,
      2,
    ),
  );
}
const result = JSON.parse(readFileSync(path, 'utf8'));
const escapeHtml = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const summary = [
  `## Migration compatibility: ${result.verdict}`,
  '',
  '**Advisory only. These are the base branch’s OLD server tests against the PR’s NEW database schema, not the PR’s tests.**',
  '',
  `Base: ${result.baseSha}; PR head: ${result.headSha}.`,
  '',
  result.error ? `Check error (compatibility unknown): ${escapeHtml(result.error)}` : '',
  ...result.failingTests.map((test) => `- ${escapeHtml(test.file)} — ${escapeHtml(test.name)}`),
  '',
  'Machine-readable verdict and full test reports: `migration-compatibility` artifact, `verdict.json`.',
  'See docs/migration-compatibility.md for coverage and exclusions.',
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
