#!/usr/bin/env node
/**
 * Measures the CRM check's classifier: runs it several times on each case
 * and reports how often it says yes. Cases are turns with an expected answer
 * ("yes", "no", or "either" for turns where a wake is fine but not needed).
 * The classifier is a model, so one run proves little: compare rates.
 *
 *   node eval/run.mjs [--cases eval/cases.json] [--runs 5] [--scripts scripts]
 *
 * It calls `claude -p` with Haiku under your own Claude Code sign-in, as the
 * hook does: runs × cases calls. Not part of `pnpm test`.
 *
 * --scripts points at another copy of turn.mjs (for example main's, through a
 * small adapter) to compare two versions on the same cases.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values: flags } = parseArgs({
  options: { cases: { type: 'string' }, runs: { type: 'string' }, scripts: { type: 'string' } },
});
const casesPath = resolve(flags.cases ?? resolve(here, 'cases.json'));
const runs = Number(flags.runs ?? 5);
const scriptsDir = resolve(flags.scripts ?? resolve(here, '..', 'scripts'));
const CONCURRENCY = 6;

const { classifierArgs, readClassifierOutput, turnText } = await import(
  pathToFileURL(resolve(scriptsDir, 'turn.mjs')).href
);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));

function classify(text) {
  return new Promise((done) => {
    const child = spawn('claude', classifierArgs(), {
      env: { ...process.env, RETAINER_CRM_HOOK: 'off' },
      cwd: homedir(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      const result = readClassifierOutput(stdout, code ?? 1);
      done(result.ok ? result.verdict.log : null);
    });
    child.stdin.end(text);
  });
}

const jobs = cases.flatMap((c, index) =>
  Array.from({ length: runs }, () => ({ index, text: turnText(c.turn) })),
);
const answers = cases.map(() => []);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      answers[job.index].push(await classify(job.text));
    }
  }),
);

const width = Math.max(...cases.map((c) => c.name.length));
const totals = { yes: [0, 0], no: [0, 0], either: [0, 0] };
let failed = 0;
cases.forEach((c, i) => {
  const yes = answers[i].filter((a) => a === true).length;
  const errors = answers[i].filter((a) => a === null).length;
  failed += errors;
  totals[c.expect][0] += yes;
  totals[c.expect][1] += runs - errors;
  const bad =
    (c.expect === 'yes' && yes < runs - errors) || (c.expect === 'no' && yes > 0) ? '  <' : '';
  console.log(
    `${c.name.padEnd(width)}  ${c.expect.padEnd(6)}  yes ${yes}/${runs}${errors ? ` (${errors} failed)` : ''}${bad}`,
  );
});
const rate = ([yes, all]) => (all ? `${Math.round((100 * yes) / all)}%` : '-');
console.log(
  `\nrecall (yes cases said yes): ${rate(totals.yes)}   ` +
    `false wakes (no cases said yes): ${rate(totals.no)}   ` +
    `either: ${rate(totals.either)}   failed runs: ${failed}`,
);
