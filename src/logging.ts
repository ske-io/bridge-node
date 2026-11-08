/**
 * Logs in the structured format the platform's logs page reads.
 *
 * On the platform every record is one JSON line on stderr:
 *
 *     {"message":"...","level_name":"ERROR","context":{...},"channel":"app",
 *      "datetime":"2026-10-28T09:30:00.123+00:00","extra":{}}
 *
 * `context` carries the fields given with the record, the request's id from
 * the platform's `X-Request-Id` header as `request_id`, and for a record with
 * an error, `exception`: `class`, `message`, `file` (where it was thrown, as
 * `path:line`), `trace` (the calls that led there, each `path:line`) and
 * `previous`, the error's `cause`.
 *
 * `console.log`, `info`, `debug`, `trace`, `warn` and `error` write records
 * in this format once an integration is installed. Set `SKE_LOG_FORMAT=plain`
 * to keep the console as it is.
 */

import { format } from 'node:util';
import { fileURLToPath } from 'node:url';

import { env, onPlatform } from './env.js';
import { state } from './state.js';

/** The levels the logs page knows, lowest first. */
export const LEVELS = ['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'] as const;

export type Level = (typeof LEVELS)[number];

export type LogContext = Record<string, unknown>;

export interface ExceptionRecord {
  class: string;
  message: string;
  file: string | null;
  trace: string[];
  previous?: ExceptionRecord;
}

/** The deepest chain of causes written for one error. */
const MAX_CAUSES = 8;

/** Whether records are written as JSON: on the platform, unless opted out. */
export function structuredLogs(): boolean {
  return onPlatform() && (env('SKE_LOG_FORMAT') ?? 'json').toLowerCase() !== 'plain';
}

/** The request id the current code runs for, if it runs for a request. */
export function currentRequestId(): string | undefined {
  return state().requests.getStore()?.requestId;
}

/**
 * Runs `fn` as part of the request with the given id: every record written
 * until it settles, in callbacks and promises it starts too, carries that id.
 * Outside it, records carry none.
 */
export function withRequestId<T>(requestId: string | undefined, fn: () => T): T {
  return state().requests.run({ requestId }, fn);
}

/** An error as the logs page reads it. */
export function exceptionRecord(error: unknown, depth = 0): ExceptionRecord {
  if (!(error instanceof Error)) {
    return { class: typeof error, message: String(error), file: null, trace: [] };
  }

  const frames = stackFrames(error.stack);
  const record: ExceptionRecord = {
    class: error.constructor?.name || error.name || 'Error',
    message: error.message,
    file: frames[0] ?? null,
    trace: frames.slice(1),
  };

  if (error.cause !== undefined && depth < MAX_CAUSES) {
    record.previous = exceptionRecord(error.cause, depth + 1);
  }
  return record;
}

/** One record, as the line written for it. */
export function formatRecord(level: Level, message: string, context: LogContext = {}, channel = 'app'): string {
  const fields: LogContext = { ...context };
  const requestId = currentRequestId();
  if (requestId !== undefined && fields.request_id === undefined) {
    fields.request_id = requestId;
  }
  if (fields.exception !== undefined && !isExceptionRecord(fields.exception)) {
    fields.exception = exceptionRecord(fields.exception);
  }

  return safeJson({
    message,
    level_name: level,
    context: fields,
    channel,
    datetime: new Date().toISOString().replace('Z', '+00:00'),
    extra: {},
  });
}

/** Writes one record: a JSON line on the platform, readable text elsewhere. */
export function write(level: Level, message: string, context: LogContext = {}, channel = 'app'): void {
  if (structuredLogs()) {
    process.stderr.write(formatRecord(level, message, context, channel) + '\n');
    return;
  }
  const { exception, ...rest } = context;
  const parts: unknown[] = [`${level} ${message}`];
  if (Object.keys(rest).length > 0) parts.push(rest);
  if (exception !== undefined) parts.push(exception);
  process.stderr.write(format(...parts) + '\n');
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  notice(message: string, context?: LogContext): void;
  warning(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  critical(message: string, context?: LogContext): void;
  alert(message: string, context?: LogContext): void;
  emergency(message: string, context?: LogContext): void;
}

/**
 * A logger writing on `channel`. Pass an error as `context.exception` to have
 * it written with its trace.
 */
export function createLogger(channel = 'app'): Logger {
  const at = (level: Level) => (message: string, context?: LogContext) => write(level, message, context, channel);
  return {
    debug: at('DEBUG'),
    info: at('INFO'),
    notice: at('NOTICE'),
    warning: at('WARNING'),
    error: at('ERROR'),
    critical: at('CRITICAL'),
    alert: at('ALERT'),
    emergency: at('EMERGENCY'),
  };
}

/** The application's logger. */
export const logger: Logger = createLogger('app');

/** The bridge's own messages. */
export const bridgeLog: Logger = createLogger('bridge');

const CONSOLE_LEVELS: Record<'log' | 'info' | 'debug' | 'trace' | 'warn' | 'error', Level> = {
  debug: 'DEBUG',
  trace: 'DEBUG',
  log: 'INFO',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

/**
 * Makes the console write structured records, once per process, when
 * structuredLogs() says so. The first error among a call's arguments becomes
 * the record's exception; the other arguments are its message, as the
 * console would print them.
 */
export function useStructuredLogs(): void {
  const current = state();
  if (current.consoleInstalled || !structuredLogs()) {
    return;
  }
  current.consoleInstalled = true;

  for (const [method, level] of Object.entries(CONSOLE_LEVELS) as [keyof typeof CONSOLE_LEVELS, Level][]) {
    console[method] = (...args: unknown[]) => {
      const index = args.findIndex((arg) => arg instanceof Error);
      const error = index === -1 ? undefined : args[index];
      const rest = index === -1 ? args : args.filter((_, i) => i !== index);
      let message = rest.length > 0 ? format(...rest) : error instanceof Error ? error.message : '';
      const context: LogContext = {};
      if (error !== undefined) {
        context.exception = exceptionRecord(error);
      } else if (method === 'trace') {
        context.exception = exceptionRecord(new Error(message));
        message = `Trace: ${message}`;
      }
      process.stderr.write(formatRecord(level, message, context, 'console') + '\n');
    };
  }
}

/** `path:line` for each frame of a V8 stack, innermost first. */
function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s+at (?:async )?(?:.*?\()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (match === null) continue;
    let file = match[1] as string;
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        // Not a path after all; keep it as written.
      }
    }
    frames.push(`${file}:${match[2]}`);
  }
  return frames;
}

function isExceptionRecord(value: unknown): value is ExceptionRecord {
  return typeof value === 'object' && value !== null && !(value instanceof Error) && 'class' in value && 'trace' in value;
}

/** JSON that never throws: circular references, BigInts and errors are written as text. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return exceptionRecord(item);
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}
