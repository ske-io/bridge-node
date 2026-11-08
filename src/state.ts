/**
 * What the package keeps for the whole process: the jobs and schedule
 * entries the application defined, and the request each log line belongs to.
 *
 * The package ships as both ES modules and CommonJS. An application can load
 * both copies at once (its own code imports one, a dependency requires the
 * other), and each copy has its own module scope, so this state lives on
 * `globalThis` under a registered symbol that both copies find.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a job's handler is given besides its payload. */
export interface JobContext {
  /** The job's id, the same on every delivery of one dispatch. */
  readonly id: string;
  /** The job's name, as defined with defineJob(). */
  readonly name: string;
  /** Which attempt this is, from 1. */
  readonly attempts: number;
  /** Aborted when the job runs out of time; a handler should stop then. */
  readonly signal: AbortSignal;
}

export type JobHandler<T = unknown> = (payload: T, job: JobContext) => unknown;

export interface ScheduledTask {
  readonly name: string;
  readonly cron: string;
  readonly timeZone?: string;
  readonly utcOffset?: number;
  readonly evenInMaintenance: boolean;
  readonly run: () => unknown;
}

/** A job dispatched off the platform, running in this process later. */
export interface LocalJob {
  readonly name: string;
  /** When it is due to start, Unix ms. */
  readonly runsAt: number;
  /** Settles once it has run, failed or not. */
  readonly settled: Promise<void>;
}

export interface LocalSession {
  /** Its jobs not settled yet, by id: those dispatched while it was open. */
  readonly pending: Map<string, LocalJob>;
  /** Its jobs that failed, as `name [id]`. */
  readonly failed: string[];
  /** Its jobs that finished after the drain's deadline, as `name [id]`. */
  readonly late: string[];
  /** When the drain stops waiting, Unix ms; set once it starts waiting. */
  deadline: number | undefined;
  /** Set once settled: later results of its jobs are ignored. */
  closed: boolean;
}

export interface RequestScope {
  readonly requestId?: string;
}

interface State {
  readonly jobs: Map<string, JobHandler<any>>;
  readonly schedule: Map<string, ScheduledTask>;
  readonly requests: AsyncLocalStorage<RequestScope>;
  /**
   * What happens to local jobs while `ske-bridge schedule` drains them: set
   * between startLocalJobs() and settleLocalJobs(), and nothing is kept
   * otherwise.
   */
  localSession: LocalSession | undefined;
  /**
   * The session of the local job running now (null for one dispatched with no
   * session open), so the jobs it dispatches belong to the same session.
   */
  readonly jobSession: AsyncLocalStorage<LocalSession | null>;
  /** The logger SkeModule made Nest's, so a later app can tell it from its own. */
  nestLogger: object | undefined;
  consoleInstalled: boolean;
  /** Set by `ske-bridge schedule` before it loads the app. */
  schedulerRun: boolean;
}

const KEY = Symbol.for('@ske-io/bridge');

export function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  let current = holder[KEY];
  if (current === undefined) {
    current = {
      jobs: new Map(),
      schedule: new Map(),
      requests: new AsyncLocalStorage<RequestScope>(),
      localSession: undefined,
      jobSession: new AsyncLocalStorage<LocalSession | null>(),
      nestLogger: undefined,
      consoleInstalled: false,
      schedulerRun: false,
    };
    holder[KEY] = current;
  }
  return current;
}
