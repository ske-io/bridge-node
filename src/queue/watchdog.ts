/**
 * The hard stop for a job that does not stop when its time is up.
 *
 * The runner's own timer shares the event loop with the job: it can tell a
 * job to stop (its abort signal) only when the job gives the loop back, and
 * nothing in JavaScript can stop a function from outside. The watchdog runs
 * in a worker thread, outside that loop. The runner arms it as a job starts
 * and disarms it once the job's handler has settled; a job still running
 * when the watchdog's time comes, a short grace after its limit, is ended
 * the only way it can be: the process is killed. That covers a job holding
 * the event loop (CPU-bound work, an endless loop) and one that yields but
 * ignores its abort signal alike.
 *
 * Nothing of the batch has been answered then, so nothing is acknowledged:
 * the platform sees the connection drop, counts the invocation as failed and
 * delivers every message of the batch again, and the container, its app
 * process gone, is replaced.
 *
 * The thread is started on the first job, so a process that never runs one
 * never starts it, and it never keeps the process alive.
 */

import { Worker } from 'node:worker_threads';

import { bridgeLog, exceptionRecord } from '../logging.js';

/**
 * Runs in the worker thread. It reads like CommonJS and like an ES module
 * alike (no `require`, no `import`: built-ins come from
 * `process.getBuiltinModule`), and the thread gets none of the app's Node
 * flags, so neither `--input-type=module` nor a loader changes how it runs.
 */
const SOURCE = `
const { parentPort } = process.getBuiltinModule('node:worker_threads');
const { writeSync } = process.getBuiltinModule('node:fs');
const timers = new Map();
parentPort.on('message', (message) => {
  clearTimeout(timers.get(message.id));
  timers.delete(message.id);
  if (message.at === undefined) return;
  timers.set(message.id, setTimeout(() => {
    const record = {
      message: message.label + ' is still running ' + message.over + 'ms past its time limit; stopping the process so the batch is delivered again',
      level_name: 'CRITICAL',
      context: message.requestId ? { request_id: message.requestId } : {},
      channel: 'bridge',
      datetime: new Date().toISOString().replace('Z', '+00:00'),
      extra: {},
    };
    try {
      writeSync(2, (message.json ? JSON.stringify(record) : 'CRITICAL ' + record.message) + '\\n');
    } finally {
      process.kill(process.pid, 'SIGKILL');
    }
  }, Math.max(0, message.at - Date.now())));
});
`;

let worker: Worker | undefined;
/** Set once the thread failed: jobs keep the runner's in-loop time limit alone. */
let unavailable = false;
let next = 0;

export interface Watch {
  /** The job's handler has settled: the watchdog stands down. */
  disarm(): void;
}

const NOTHING: Watch = { disarm: () => undefined };

/**
 * Kills the process at `at` (Unix ms) unless the returned watch is disarmed
 * first. When the watchdog's thread cannot run (a permission model that
 * refuses threads, say), that is logged once and jobs keep the runner's own
 * time limit, which stops only jobs that yield: the app is never taken down
 * by the watchdog failing.
 */
export function watch(at: number, label: string, details: { over: number; requestId: string | undefined; json: boolean }): Watch {
  const thread = start();
  if (thread === undefined) return NOTHING;
  const id = ++next;
  thread.postMessage({ id, at, label, ...details });
  return { disarm: () => worker === thread && thread.postMessage({ id }) };
}

function start(): Worker | undefined {
  if (unavailable) return undefined;
  if (worker !== undefined) return worker;
  try {
    const thread = new Worker(SOURCE, { eval: true, execArgv: [] });
    thread.unref();
    // An error here would otherwise be thrown at the app's process.
    thread.on('error', (error) => fail(thread, error));
    thread.on('exit', (code) => fail(thread, new Error(`the watchdog's thread exited with code ${code}`)));
    worker = thread;
    return thread;
  } catch (error) {
    fail(undefined, error);
    return undefined;
  }
}

function fail(thread: Worker | undefined, error: unknown): void {
  if (unavailable || (thread !== undefined && worker !== thread)) return;
  unavailable = true;
  worker = undefined;
  bridgeLog.error(
    "The jobs' watchdog could not start, so a job that holds the event loop or ignores its abort signal past its time limit is not stopped; jobs that stop when told still are",
    { exception: exceptionRecord(error) },
  );
}
