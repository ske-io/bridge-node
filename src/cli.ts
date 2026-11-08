#!/usr/bin/env node
/**
 * `ske-bridge schedule [entry]`: the command the platform runs once a minute.
 *
 * It loads the app's schedule entry, runs the tasks due this minute (see
 * tick), waits for them, and exits: 0 when every due task succeeded, 1 when
 * any failed or the app could not be loaded.
 *
 * The entry is the file named on the command line, else `"ske": {"schedule":
 * "<file>"}` in package.json, else `dist/app.module.js` when the app is a
 * NestJS app. A plain Node entry is a module that adds tasks with schedule()
 * when it is loaded, without starting a server. A Nest entry exports the
 * app's root module (`AppModule`, or the export named after `#`, as in
 * `dist/app.module.js#AppModule`): the command creates an application
 * context from it, with no HTTP server, and runs the `@Cron` methods
 * SkeModule finds as well as the schedule() tasks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { onPlatform } from './env.js';
import { bridgeLog, exceptionRecord, useStructuredLogs } from './logging.js';
import { settleLocalJobs, startLocalJobs } from './queue/jobs.js';
import { scheduledTasks } from './schedule/schedule.js';
import { scheduledMinute, tick } from './schedule/tick.js';
import { state, type ScheduledTask } from './state.js';

const USAGE = `Usage: ske-bridge schedule [entry]

Runs the scheduled tasks due this minute, then exits.

  entry   The module that defines the schedule. Defaults to "ske.schedule" in
          package.json, else dist/app.module.js for a NestJS app.`;

const NEST_ENTRY = 'dist/app.module.js';

/** How long, off the platform, the run waits for the jobs its tasks dispatched. */
const LOCAL_JOBS_WAIT_MS = 60_000;

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (command !== 'schedule' || rest.length > 1) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  useStructuredLogs();
  state().schedulerRun = true;
  // Off the platform jobs run here: from now on, so the jobs the entry
  // dispatches as it loads count too.
  if (!onPlatform()) startLocalJobs();

  const cwd = process.cwd();
  const entry = rest[0] ?? configuredEntry(cwd) ?? (isNestApp(cwd) ? NEST_ENTRY : undefined);
  if (entry === undefined) {
    bridgeLog.info('No schedule entry: set "ske": {"schedule": "<file>"} in package.json to schedule tasks');
    return 0;
  }

  const [file, exportName] = splitEntry(entry);
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    bridgeLog.error(`The schedule entry ${file} does not exist; build the app, or set "ske.schedule" in package.json`);
    return 1;
  }

  let close: () => Promise<void> = async () => undefined;
  let tasks: ScheduledTask[];
  try {
    const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const rootModule = nestRootModule(loaded, exportName, isNestApp(cwd));
    if (rootModule !== undefined) {
      const nest = await bootNest(cwd, rootModule);
      close = nest.close;
      tasks = [...scheduledTasks(), ...nest.tasks];
    } else if (exportName !== undefined) {
      bridgeLog.error(`The schedule entry ${file} has no export named ${exportName}`);
      return 1;
    } else {
      tasks = scheduledTasks();
    }
  } catch (error) {
    bridgeLog.error(`The schedule entry ${file} could not be loaded`, { exception: exceptionRecord(error) });
    return 1;
  }

  const result = await tick(tasks, scheduledMinute());
  const jobsOk = await awaitLocalJobs();

  try {
    await close();
  } catch (error) {
    bridgeLog.warning('The app did not shut down cleanly', { exception: exceptionRecord(error) });
  }
  return result.failed.length > 0 || !jobsOk ? 1 : 0;
}

/**
 * Off the platform, dispatch() runs jobs in this process after the task that
 * dispatched them has returned. They are waited for (and the jobs they
 * dispatch), at most LOCAL_JOBS_WAIT_MS, before the app is closed, so none is
 * dropped by the exit; one that fails, or would start after the wait, fails
 * the run. On the platform jobs go to the queue, and there is nothing to wait
 * for here.
 */
async function awaitLocalJobs(): Promise<boolean> {
  if (onPlatform()) return true;
  const { failed, late, unfinished } = await settleLocalJobs(LOCAL_JOBS_WAIT_MS);
  for (const job of unfinished) {
    bridgeLog.error(`Job ${job} was not run: it was still pending ${LOCAL_JOBS_WAIT_MS / 1000}s after the schedule ran`);
  }
  for (const job of late) {
    bridgeLog.error(`Job ${job} finished after the ${LOCAL_JOBS_WAIT_MS / 1000}s wait for the schedule's jobs`);
  }
  if (failed.length > 0) {
    bridgeLog.error(`${failed.length} job(s) dispatched by the schedule failed: ${failed.join(', ')}`);
  }
  return failed.length === 0 && late.length === 0 && unfinished.length === 0;
}

function configuredEntry(cwd: string): string | undefined {
  const config = (readPackage(cwd)?.ske as { schedule?: unknown } | undefined)?.schedule;
  return typeof config === 'string' && config !== '' ? config : undefined;
}

function isNestApp(cwd: string): boolean {
  const pkg = readPackage(cwd);
  const dependencies = { ...(pkg?.dependencies as object | undefined), ...(pkg?.devDependencies as object | undefined) };
  return '@nestjs/core' in dependencies || existsSync(resolve(cwd, 'nest-cli.json'));
}

function readPackage(cwd: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function splitEntry(entry: string): [string, string | undefined] {
  const hash = entry.lastIndexOf('#');
  return hash === -1 ? [entry, undefined] : [entry.slice(0, hash), entry.slice(hash + 1) || undefined];
}

/**
 * The Nest root module the entry exports, if it is a Nest entry: the export
 * named after `#`, else `AppModule`, else the default export of a NestJS
 * app's entry.
 */
function nestRootModule(loaded: Record<string, unknown>, exportName: string | undefined, nestApp: boolean): Function | undefined {
  const candidates = exportName !== undefined ? [exportName] : nestApp ? ['AppModule', 'default'] : ['AppModule'];
  for (const name of candidates) {
    let value = loaded[name];
    if (name === 'default' && typeof value === 'object' && value !== null) {
      value = (value as Record<string, unknown>).AppModule;
    }
    if (typeof value === 'function') return value;
  }
  return undefined;
}

interface NestApp {
  get(token: unknown, options?: { strict?: boolean }): unknown;
  close(): Promise<void>;
}

async function bootNest(cwd: string, rootModule: Function): Promise<{ tasks: ScheduledTask[]; close: () => Promise<void> }> {
  // Nest from the app's own node_modules, so the app and this command share
  // one copy of it.
  const fromApp = createRequire(resolve(cwd, 'package.json'));
  const core = (await import(pathToFileURL(fromApp.resolve('@nestjs/core')).href)) as {
    NestFactory: { createApplicationContext(module: unknown, options?: object): Promise<NestApp> };
  };
  const { SkeLogger } = await import('./nest-logger.js');

  const app = await core.NestFactory.createApplicationContext(rootModule, {
    // Quiet: a run every minute would log Nest's whole start-up each time.
    // Its warnings and errors still show.
    logger: new SkeLogger({ levels: ['warn', 'error', 'fatal'] }),
    abortOnError: false,
  });

  let explorer: { scheduledTasks(): ScheduledTask[] };
  try {
    explorer = app.get(Symbol.for('@ske-io/bridge:schedule'), { strict: false }) as typeof explorer;
  } catch {
    bridgeLog.warning('SkeModule is not imported, so @Cron methods are not run; add SkeModule.forRoot() to the root module');
    return { tasks: [], close: () => app.close() };
  }
  return { tasks: explorer.scheduledTasks(), close: () => app.close() };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    bridgeLog.error('The schedule could not run', { exception: exceptionRecord(error) });
    process.exit(1);
  },
);
