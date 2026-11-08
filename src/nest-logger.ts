/**
 * Nest's logger, writing the platform's log records. SkeModule makes it Nest's
 * logger on the platform; pass it to `NestFactory.create(AppModule, { logger:
 * new SkeLogger() })` to have Nest's start-up lines in the same format. The
 * Nest context (`new Logger('Orders')`) is the record's channel.
 */

import type { LoggerService } from '@nestjs/common';

import { exceptionRecord, write, type Level, type LogContext } from './logging.js';

export interface SkeLoggerOptions {
  /** The Nest levels written; every level by default. */
  levels?: NestLevel[];
}

type NestLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

export class SkeLogger implements LoggerService {
  private readonly levels: ReadonlySet<NestLevel> | undefined;

  constructor(options: SkeLoggerOptions = {}) {
    this.levels = options.levels === undefined ? undefined : new Set(options.levels);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', 'INFO', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', 'ERROR', message, params, true);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', 'WARNING', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', 'DEBUG', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', 'DEBUG', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', 'CRITICAL', message, params);
  }

  /** Filtered by the Nest method's own level, then written at the platform's. */
  private emit(nest: NestLevel, level: Level, message: unknown, params: unknown[], withStack = false): void {
    if (this.levels !== undefined && !this.levels.has(nest)) return;
    this.record(level, message, params, withStack);
  }

  private record(level: Level, message: unknown, params: unknown[], withStack = false): void {
    const rest = [...params];
    const channel = typeof rest.at(-1) === 'string' ? (rest.pop() as string) : 'nest';
    const context: LogContext = {};
    if (message instanceof Error) {
      context.exception = exceptionRecord(message);
    } else if (withStack && typeof rest[0] === 'string' && rest[0].includes('\n    at ')) {
      const error = new Error(String(message));
      error.stack = rest.shift() as string;
      context.exception = exceptionRecord(error);
    }
    for (const param of rest) {
      if (param instanceof Error) context.exception = exceptionRecord(param);
      else if (typeof param === 'object' && param !== null) Object.assign(context, param);
    }
    const text = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    write(level, text, context, channel);
  }
}

