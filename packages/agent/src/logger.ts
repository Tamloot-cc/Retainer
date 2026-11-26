import { MastraLogger } from '@mastra/core/logger';

type Fields = Record<string, string | number | boolean | null | undefined>;

/** Where log lines go: one JSON object per line, stderr by default. */
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => process.stderr.write(`${line}\n`);

/** Tests capture every line the runtime would write. */
export function setLogSink(next: LogSink): void {
  sink = next;
}

/**
 * The runtime's own log: an event name and IDs, codes and counts only.
 * Never a message, a tool input or output, a prompt or a token (spec §5.3).
 */
export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}) {
  sink(JSON.stringify({ level, source: 'agent', event, ...fields, at: new Date().toISOString() }));
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Codes and metadata from an error, never its message or the bodies it carries. */
export function errorFields(error: unknown): Fields {
  if (!error || typeof error !== 'object') return { errorType: typeof error };
  const e = error as Record<string, unknown>;
  const pick = (value: unknown) =>
    typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
  return {
    errorName: pick(e.name),
    errorCode: pick(e.code) ?? pick(e.id),
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
    isRetryable: typeof e.isRetryable === 'boolean' ? e.isRetryable : undefined,
  };
}

/**
 * Mastra's logger, replaced: Mastra's errors carry request values and
 * response bodies, and its default logger writes them where deleting a chat
 * can't reach them (spec §5.3). This one keeps the level, Mastra's component
 * and the codes of any error argument. Messages are dropped: they can quote
 * content.
 */
export class ContentFreeLogger extends MastraLogger {
  constructor() {
    super({ name: 'retainer-agent', level: 'warn' as never });
  }

  #write(level: 'warn' | 'error', args: unknown[]) {
    const error = args.find((arg) => arg instanceof Error || (arg && typeof arg === 'object'));
    sink(
      JSON.stringify({
        level,
        source: 'mastra',
        ...(error ? errorFields(error) : {}),
        at: new Date().toISOString(),
      }),
    );
  }

  debug(): void {}
  info(): void {}
  warn(_message: string, ...args: unknown[]): void {
    this.#write('warn', args);
  }
  error(_message: string, ...args: unknown[]): void {
    this.#write('error', args);
  }
  trackException(error: Error): void {
    this.#write('error', [error]);
  }
}
