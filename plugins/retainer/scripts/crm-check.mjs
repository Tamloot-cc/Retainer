#!/usr/bin/env node
/**
 * Stop hook, run in the background (asyncRewake) after every turn. It decides
 * *when* to log: it asks a small model whether the turn holds something the
 * person's CRM should keep, and if so exits with code 2, which wakes Claude
 * with the message on stderr. Claude then decides *what* to write, following
 * the server's log_from_chat guide, which the message points it to.
 *
 * Retainer itself never calls a model: this runs on the person's machine,
 * through their own Claude Code sign-in. Every decision is logged to
 * crm-check.log in the plugin's data directory.
 *
 * Off switch: RETAINER_CRM_HOOK=off (in the environment or in the "env" of a
 * Claude Code settings file), or disable the plugin.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLASSIFIER_PROMPT,
  isAuthFailure,
  lastTurn,
  parseTranscript,
  parseVerdict,
  skipReason,
  turnText,
  wakeMessage,
} from './turn.mjs';

const WAKE = 2;
const CLASSIFIER_TIMEOUT_MS = 90_000;
/** Reading more than this of a transcript is wasted work: the turn is near its end. */
const TAIL_BYTES = 4 * 1024 * 1024;
const AUTH_WARNING_EVERY_MS = 24 * 60 * 60 * 1000;

const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'retainer-plugin');

function log(message) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'crm-check.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never break the hook.
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  } catch {
    return { checked: {} };
  }
}

function writeState(state) {
  // Keep the last 200 sessions; older ones will never stop again.
  const sessions = Object.entries(state.checked ?? {}).slice(-200);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({ ...state, checked: Object.fromEntries(sessions) }),
    );
  } catch (error) {
    log(`could not save state: ${error.message}`);
  }
}

function readTail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

/** Runs `claude -p` with Haiku, and with hooks, MCP servers, skills and tools off. */
function classify(text) {
  const args = [
    '-p',
    '--model',
    'haiku',
    '--output-format',
    'json',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
    '--disable-slash-commands',
    '--tools',
    '',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      // The off switch doubles as a recursion guard, should hooks run anyway.
      env: { ...process.env, RETAINER_CRM_HOOK: 'off' },
      cwd: homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), CLASSIFIER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = stdout;
      let isError = code !== 0;
      try {
        const json = JSON.parse(stdout);
        result = typeof json.result === 'string' ? json.result : '';
        isError ||= json.is_error === true;
      } catch {
        // Not JSON: keep the raw output for the log.
      }
      resolve({ ok: !isError, output: isError ? `${result}\n${stderr}`.trim() : result });
    });
    child.stdin.end(CLASSIFIER_PROMPT + text);
  });
}

async function main() {
  if (process.env.RETAINER_CRM_HOOK === 'off') return 0;
  const input = await readStdin();
  if (input.stop_hook_active) return 0;
  const session = input.session_id ?? 'unknown';

  let entries = [];
  try {
    if (input.transcript_path) entries = parseTranscript(readTail(input.transcript_path));
  } catch (error) {
    log(`${session} skip: cannot read transcript (${error.message})`);
    return 0;
  }

  const state = readState();
  const turn = lastTurn(entries, input.prompt_id);
  const reason = skipReason(turn, { checked: state.checked?.[session] });
  if (reason) {
    log(`${session} skip: ${reason}`);
    return 0;
  }
  state.checked = { ...state.checked, [session]: turn.id };
  writeState(state);

  const result = await classify(turnText(turn, input.last_assistant_message));
  if (!result.ok) {
    log(`${session} classifier failed: ${result.output.slice(0, 300).replace(/\s+/g, ' ')}`);
    const warnedAt = state.authWarnedAt ?? 0;
    if (isAuthFailure(result.output) && Date.now() - warnedAt > AUTH_WARNING_EVERY_MS) {
      writeState({ ...state, authWarnedAt: Date.now() });
      process.stderr.write(
        "Retainer's CRM check could not run: Claude Code's sign-in for `claude -p` has " +
          'expired. Tell the user, in one line, to run `claude auth login` in a terminal so ' +
          'turns keep being checked for CRM updates. Do nothing else.',
      );
      return WAKE;
    }
    return 0;
  }
  if (state.authWarnedAt) writeState({ ...state, authWarnedAt: 0 });

  const verdict = parseVerdict(result.output);
  log(`${session} ${verdict.log ? 'log' : 'no'}: ${verdict.what || '-'}`);
  if (!verdict.log) return 0;

  process.stderr.write(wakeMessage(verdict.what, session));
  return WAKE;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log(`error: ${error?.stack ?? error}`);
    process.exit(0);
  },
);
