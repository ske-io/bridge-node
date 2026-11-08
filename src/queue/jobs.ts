/**
 * Background jobs: a name, a handler, and dispatch() to run it later.
 *
 *     const welcome = defineJob('send-welcome-mail', async (payload: { userId: string }) => { ... });
 *     await dispatch('send-welcome-mail', { userId }, { delay: 30 });
 *     await welcome.dispatch({ userId });
 *
 * On the platform dispatch() sends the job to the environment's queue and
 * the platform delivers it back to the application, which runs the handler
 * (see the queue runner). Off the platform it runs the handler in this
 * process on the next tick, after the delay; with `SKE_QUEUE_SYNC=1` it runs
 * it before dispatch() returns, for tests.
 *
 * The payload travels as JSON, so the handler gets a JSON copy of it in
 * every case: dates become strings and functions disappear, on the platform
 * and off it alike.
 */

import { randomUUID } from 'node:crypto';

import { env, onPlatform } from '../env.js';
import { bridgeLog, exceptionRecord } from '../logging.js';
import { state, type JobContext, type JobHandler } from '../state.js';
import { encodeMessage } from './message.js';
import { MAX_DELAY, queueName, sendMessage } from './sqs.js';

export type { JobContext, JobHandler };

export interface DispatchOptions {
  /** Seconds to wait before the job runs, at most 900. */
  delay?: number;
  /** The queue to send it to, by its name in the environment. */
  queue?: string;
}

export interface Job<T> {
  readonly name: string;
  /** dispatch() for this job. */
  dispatch(payload: T, options?: DispatchOptions): Promise<string>;
}

/**
 * Defines the job `name`. Defining a name twice is an error: a delivered
 * message names its job, and must find exactly one handler.
 */
export function defineJob<T = unknown>(name: string, handler: JobHandler<T>): Job<T> {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('A job needs a name');
  }
  if (typeof handler !== 'function') {
    throw new TypeError(`Job ${JSON.stringify(name)} needs a handler function`);
  }
  const { jobs } = state();
  if (jobs.has(name)) {
    throw new Error(`A job named ${JSON.stringify(name)} is already defined`);
  }
  jobs.set(name, handler as JobHandler<unknown>);
  return { name, dispatch: (payload, options) => dispatch(name, payload, options) };
}

/** The handler of the job `name`, if it is defined. */
export function jobHandler(name: string): JobHandler<unknown> | undefined {
  return state().jobs.get(name);
}

/**
 * Runs the job `name` with `payload` later, and resolves to the job's id once
 * it is queued. Rejects when the job is not defined, the payload is not JSON
 * or the queue refuses the message.
 */
export async function dispatch(name: string, payload: unknown, options: DispatchOptions = {}): Promise<string> {
  const handler = jobHandler(name);
  if (handler === undefined) {
    throw new Error(`No job named ${JSON.stringify(name)} is defined`);
  }

  const delay = options.delay ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY) {
    throw new RangeError(`A job's delay is a whole number of seconds from 0 to ${MAX_DELAY}, not ${delay}`);
  }

  const json = JSON.stringify(payload === undefined ? null : payload);
  if (json === undefined) {
    throw new TypeError(`The payload of job ${JSON.stringify(name)} is not a JSON value`);
  }

  const id = randomUUID();

  if (onPlatform()) {
    const queue = queueName(options.queue);
    await sendMessage(queue, encodeMessage({ job: name, payload: JSON.parse(json), id }), delay);
    return id;
  }

  const run = () => handler(JSON.parse(json), { id, name, attempts: 1, signal: new AbortController().signal });

  if (env('SKE_QUEUE_SYNC') === '1') {
    await run();
    return id;
  }

  // While `ske-bridge schedule` drains local jobs, it waits for this one and
  // hears how it went (see settleLocalJobs); otherwise nothing is kept. A job
  // dispatched by a local job belongs to that job's session, even one closed
  // since, whose results are ignored; any other to the session open now.
  const current = state();
  const inherited = current.jobSession.getStore();
  const owner = inherited === undefined ? current.localSession : (inherited ?? undefined);
  const session = owner !== undefined && !owner.closed ? owner : undefined;
  const label = `${name} [${id}]`;
  const settled = new Promise<void>((resolve) => {
    const later = () => {
      Promise.resolve()
        .then(() => current.jobSession.run(owner ?? null, run))
        .catch((error: unknown) => {
          if (session !== undefined && !session.closed) session.failed.push(label);
          bridgeLog.error(`Job ${label} failed`, { exception: exceptionRecord(error) });
        })
        .finally(() => {
          if (session !== undefined && !session.closed) {
            // A handler that holds the event loop can finish past the
            // deadline without the drain's timer ever firing: the clock says so.
            if (session.deadline !== undefined && Date.now() > session.deadline) session.late.push(label);
            session.pending.delete(id);
          }
          resolve();
        });
    };
    if (delay > 0) setTimeout(later, delay * 1000);
    else setImmediate(later);
  });
  session?.pending.set(id, { name, runsAt: Date.now() + delay * 1000, settled });
  return id;
}

export interface LocalJobsResult {
  /** The jobs that failed, as `name [id]`. */
  readonly failed: string[];
  /** The jobs that finished, but after the wait's end, as `name [id]`. */
  readonly late: string[];
  /** The jobs still not run when the wait ended, as `name [id]`. */
  readonly unfinished: string[];
}

/**
 * Opens a drain session: the local jobs dispatched from now on, and the jobs
 * they dispatch, are waited for and reported by settleLocalJobs(). Only
 * `ske-bridge schedule` opens one, once per process; without a session
 * nothing is kept, so a long-running app's failed jobs are logged and
 * forgotten. Throws while a session is open.
 */
export function startLocalJobs(): void {
  const current = state();
  if (current.localSession !== undefined) {
    throw new Error('A drain of local jobs is already open');
  }
  current.localSession = { pending: new Map(), failed: [], late: [], deadline: undefined, closed: false };
}

/**
 * Waits, at most `timeoutMs`, for the open session's jobs to run, and closes
 * it. A job due to start after the wait would end is not waited for: it is
 * reported unfinished at once, as is one still running when the wait ends;
 * what becomes of them later is reported nowhere. The wait is the event
 * loop's: a handler that holds the loop is not interrupted (only the
 * platform's queue has a watchdog), and one finishing past the deadline is
 * reported late. Without an open session there is nothing to wait for.
 */
export async function settleLocalJobs(timeoutMs: number): Promise<LocalJobsResult> {
  const current = state();
  const session = current.localSession;
  if (session === undefined) {
    return { failed: [], late: [], unfinished: [] };
  }
  const deadline = Date.now() + timeoutMs;
  session.deadline = deadline;
  const late = (job: { runsAt: number }) => job.runsAt > deadline;

  try {
    for (;;) {
      const waiting = [...session.pending.values()].filter((job) => !late(job));
      const left = deadline - Date.now();
      if (waiting.length === 0 || left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(waiting.map((job) => job.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    return {
      failed: [...session.failed],
      late: [...session.late],
      unfinished: [...session.pending.entries()].map(([id, job]) => `${job.name} [${id}]`),
    };
  } finally {
    session.closed = true;
    session.pending.clear();
    if (current.localSession === session) current.localSession = undefined;
  }
}

/** Removes the job `name` when it still has `handler`; for integrations that shut down. */
export function undefineJob(name: string, handler: JobHandler<any>): void {
  const { jobs } = state();
  if (jobs.get(name) === handler) jobs.delete(name);
}
