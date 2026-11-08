/**
 * Runs the jobs the platform delivered in one call to `/__ske/queue`.
 *
 * The platform posts a batch of SQS records and the queue's settings:
 *
 *     {"source":"sqs","records":[{"message_id":"…","body":"…","attempts":1}],
 *      "options":{"timeout":60,"tries":3,"backoff":5,"deadline_ms":1800000000000}}
 *
 * Each record is run once, in order, and gets exactly one outcome:
 *
 * - An unreadable body, or one naming a job this process does not define,
 *   fails at once: running it again cannot help.
 * - A delivery already past `tries` (the total attempts allowed, 1 when
 *   unset) fails without running.
 * - The handler resolved: deleted.
 * - The handler threw or timed out: released after `backoff` seconds while
 *   attempts are left, else failed.
 * - The batch's time ran out before the job started, or while it ran: it is
 *   released with no failure counted against it, to run in a later delivery.
 *
 * Time: each job has `timeout` seconds less a margin (5 seconds, or half the
 * timeout when that is less) for reporting outcomes. The batch has one
 * deadline as well: the platform's `deadline_ms`, less the same kind of
 * margin, or else the job time counted from when the batch's request
 * arrived. A job's limit is the earlier of the two, for every job of the
 * batch, the first included; a job stopped by the batch's deadline rather
 * than its own limit is released.
 *
 * Stopping a job: when it runs out of time its `signal` is aborted, and the
 * handler has a short grace to settle; its outcome (never an
 * acknowledgement) is reported only once it has. A handler that returns late
 * after holding the event loop (CPU-bound work, a long synchronous call)
 * counts as out of time too. JavaScript cannot stop a function from outside,
 * so a handler still running when the grace ends, whether it holds the loop
 * or ignores its signal, is ended by the watchdog killing the process:
 * nothing of the batch is answered, and the platform delivers the batch
 * again (see watchdog).
 */

import { bridgeLog, currentRequestId, exceptionRecord, structuredLogs } from '../logging.js';
import { decodeMessage, InvalidMessage } from './message.js';
import { jobHandler } from './jobs.js';
import { deleted, failed, released, type JobOutcome } from './outcome.js';
import { watch } from './watchdog.js';

/** The most seconds kept back from a timeout or deadline for answering. */
export const MARGIN = 5;

/** How long past its limit a job holding the event loop is given before the process is killed, at most. */
export const GRACE_MS = 1000;

/** SQS's longest visibility timeout: a released message waits at most this. */
export const MAX_RELEASE_DELAY = 43200;

export interface QueueRecord {
  message_id?: unknown;
  body?: unknown;
  attempts?: unknown;
}

export interface QueueOptions {
  timeout?: unknown;
  tries?: unknown;
  backoff?: unknown;
  deadline_ms?: unknown;
}

/** The seconds a job may run on a queue with the given timeout. */
export function jobSeconds(timeout: number): number {
  return Math.max(1, timeout - Math.min(MARGIN, Math.floor(timeout / 2)));
}

/**
 * One outcome per record, in the order they arrived. `received` is when the
 * batch's request reached the app (Unix ms): reading and parsing it count
 * against the batch's time.
 */
export async function runBatch(records: QueueRecord[], options: QueueOptions = {}, received = Date.now()): Promise<JobOutcome[]> {
  const timeout = positiveInt(options.timeout) ?? 60;
  const tries = positiveInt(options.tries) ?? 1;
  const backoff = Math.min(nonNegativeInt(options.backoff) ?? 0, MAX_RELEASE_DELAY);
  const jobMs = jobSeconds(timeout) * 1000;

  const deadlineMs = positiveInt(options.deadline_ms);
  const cutoff =
    deadlineMs !== undefined
      ? deadlineMs - Math.min(MARGIN * 1000, Math.max(deadlineMs - received, 0) / 2)
      : received + jobMs;

  // When the platform ends the invocation: the watchdog's grace stays short of it.
  const end = deadlineMs ?? received + timeout * 1000;

  const outcomes: JobOutcome[] = [];
  for (const record of records) {
    outcomes.push(await runOne(typeof record === 'object' && record !== null ? record : {}, { tries, backoff, jobMs, cutoff, end }));
  }
  return outcomes;
}

interface Policy {
  tries: number;
  backoff: number;
  jobMs: number;
  cutoff: number;
  /** When the platform ends the invocation, Unix ms. */
  end: number;
}

async function runOne(record: QueueRecord, policy: Policy): Promise<JobOutcome> {
  const messageId = typeof record.message_id === 'string' ? record.message_id : String(record.message_id ?? '');
  const attempts = positiveInt(record.attempts) ?? 1;

  let message;
  try {
    message = decodeMessage(record.body);
  } catch (error) {
    const reason = error instanceof InvalidMessage ? error.message : String(error);
    bridgeLog.error(`Message ${messageId} is not a job: ${reason}`);
    return failed(messageId, attempts, `unreadable message: ${reason}`);
  }

  const handler = jobHandler(message.job);
  if (handler === undefined) {
    bridgeLog.error(`Message ${messageId} names job ${message.job}, which is not defined`);
    return failed(messageId, attempts, `job ${JSON.stringify(message.job)} is not defined`);
  }

  if (attempts > policy.tries) {
    return failed(messageId, attempts, `delivered ${attempts} times, more than the ${policy.tries} tries allowed`);
  }

  const started = Date.now();
  const left = policy.cutoff - started;
  if (left <= 0) {
    return released(messageId, attempts, null, "not started: the batch's time ran out");
  }
  const cut = left < policy.jobMs;
  const limit = cut ? left : policy.jobMs;
  const label = `Job ${message.job} [${message.id}]`;

  // The hard stop: a short grace after the job's limit, half the time left
  // before the platform's own end at most. The watchdog stands down only once
  // the handler has settled, so a job still running then, whether it holds the
  // event loop or ignores its abort signal, ends with the process.
  const stopAt = started + limit;
  const grace = Math.max(0, Math.min(GRACE_MS, (policy.end - stopAt) / 2));
  const watchdog = watch(stopAt + grace, label, { over: Math.round(grace), requestId: currentRequestId(), json: structuredLogs() });

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), limit);
  });

  const running = Promise.resolve().then(() =>
    handler(message.payload, { id: message.id, name: message.job, attempts, signal: controller.signal }),
  );

  let result: 'timeout' | { error: unknown } | undefined;
  try {
    result = await Promise.race([running.then(() => undefined), timedOut]);
  } catch (error) {
    result = { error };
  } finally {
    clearTimeout(timer);
  }

  // The timer and the handler share one event loop: a handler that blocks it
  // (CPU-bound work, a long synchronous call) settles before the timer can
  // fire, however long it took. Whatever it settled with, a job that ran past
  // its limit is out of time, and is never acknowledged.
  if (result !== 'timeout' && Date.now() > stopAt) {
    result = 'timeout';
  }

  if (result === undefined) {
    watchdog.disarm();
    return deleted(messageId, attempts);
  }

  if (result === 'timeout') {
    // Told to stop, the handler has until the grace ends to settle; the batch
    // is answered only after it has, so a released job never runs on beside
    // its own redelivery. One that doesn't settle is ended by the watchdog.
    controller.abort(new Error('The job ran out of time'));
    try {
      await running;
    } catch (error) {
      bridgeLog.error(`${label} failed after it ran out of time`, { exception: exceptionRecord(error) });
    }
    watchdog.disarm();
    if (cut) {
      bridgeLog.warning(`${label} was stopped at the batch's deadline; it runs again in a later delivery`);
      return released(messageId, attempts, null, "stopped at the batch's deadline");
    }
    return retryOrFail(messageId, attempts, policy, `${label} ran past its ${Math.round(limit / 1000)}s time limit`);
  }

  watchdog.disarm();
  bridgeLog.error(`${label} failed`, { exception: exceptionRecord(result.error) });
  return retryOrFail(messageId, attempts, policy, describe(result.error));
}

function retryOrFail(messageId: string, attempts: number, policy: Policy, error: string): JobOutcome {
  return attempts < policy.tries ? released(messageId, attempts, policy.backoff, error) : failed(messageId, attempts, error);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
