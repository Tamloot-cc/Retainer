/**
 * The first module of a routine's child process (routines spec §3.3). Node's
 * permission model already refuses the file system beyond this directory,
 * child processes, workers and native addons; this prelude closes the rest
 * before the routine's code loads:
 *
 * - module loading: after this file, nothing resolves but the routine itself,
 *   so `import('node:net')` fails however it is spelled;
 * - globals that reach out: fetch, WebSocket, EventSource,
 *   `process.getBuiltinModule` and `process.binding` are removed, and
 *   `process` itself is hidden;
 * - `console` goes to the runner as the run's log.
 *
 * The child holds no token: every read and effect is a line to the runner,
 * which makes the call with the run's token.
 */
export const SANDBOX_PRELUDE = String.raw`
import { registerHooks } from 'node:module';

const proc = globalThis.process;
const stdin = proc.stdin;
const stdout = proc.stdout;
const write = stdout.write.bind(stdout);
const send = (message) => write(JSON.stringify(message) + '\n');

let routineLoaded = false;
registerHooks({
  resolve(specifier, context, next) {
    if (!routineLoaded && specifier === './routine.mjs') return next(specifier, context);
    throw new Error('routine code cannot import modules');
  },
});

for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try { delete globalThis[name]; } catch {}
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
}
for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'reallyExit', 'kill', 'chdir', 'setuid', 'setgid']) {
  try { proc[name] = undefined; } catch {}
}

const format = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const log = (...data) => send({ kind: 'log', text: data.map(format).join(' ').slice(0, 500) });
globalThis.console = { log, info: log, warn: log, error: log, debug: log };

const pending = new Map();
let seq = 0;
let position = 0;
let started;
const start = new Promise((resolve) => { started = resolve; });

let buffer = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.kind === 'start') { started(message.context); continue; }
    const call = pending.get(message.id);
    if (!call) continue;
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      call.reject(error);
    } else call.resolve(message.result);
  }
});

const plain = (value) => (value === undefined ? {} : JSON.parse(JSON.stringify(value)));
const ask = (message) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  send({ ...message, id });
});
// Positions are taken when the code makes the call, so a retry asks for the same ones.
const effect = (operation, args) => {
  const at = ++position;
  return ask({ kind: 'effect', position: at, operation, args: plain(args) });
};
const read = (operation, args) => ask({ kind: 'read', operation, args: plain(args) });

const cite = (options) => (options && options.source !== undefined ? { source: options.source } : {});
const objectClient = (object) => Object.freeze({
  get: (id) => read('record.get', { object, id }),
  query: (input) => read('record.query', { object, ...plain(input) }),
  aggregate: (input) => read('record.aggregate', { object, ...plain(input) }),
  // The citation travels beside the values, so a field keyed "source" is a value.
  create: (values, options) => effect('record.create', { object, values, ...cite(options) }),
  update: (id, values, options) => effect('record.update', { object, id, values, ...cite(options) }),
});
const tools = new Proxy({}, {
  get: (_, name) => (typeof name === 'string' && name !== 'then'
    ? (input) => effect('tool', { name, input: plain(input) })
    : undefined),
});
const fixed = {
  files: Object.freeze({ text: (id) => read('files.text', { id }) }),
  events: Object.freeze({ log: (input) => effect('events.log', input) }),
  remember: (input) => effect('remember', input),
  tools,
  ai: Object.freeze({ generate: (input) => effect('ai.generate', input) }),
};
const retainer = new Proxy({}, {
  get: (_, name) => {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return Object.hasOwn(fixed, name) ? fixed[name] : objectClient(name);
  },
});

const fail = (error) => send({ kind: 'error', message: String(error?.message ?? error), code: error?.code });
proc.on('unhandledRejection', fail);
proc.on('uncaughtException', fail);
try { Object.defineProperty(globalThis, 'process', { value: undefined, configurable: false, writable: false }); } catch {}

try {
  const routine = await import('./routine.mjs');
  routineLoaded = true;
  if (typeof routine.main !== 'function') throw new Error('the routine does not export main');
  const context = await start;
  const result = await routine.main({ retainer, record: context.record, run: context.run, trigger: context.trigger });
  send({ kind: 'done', result: result === undefined ? null : result });
} catch (error) {
  fail(error);
}
`;
