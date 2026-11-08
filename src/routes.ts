/**
 * The platform's internal routes, independent of any framework.
 *
 * Every integration hands `/__ske/*` requests here before the framework's
 * routing, middleware and hooks see them: a login requirement, CSRF
 * protection or a host check has nothing to say about a request the platform
 * built for itself.
 *
 * - `GET`/`HEAD /__ske/health` is the readiness route the platform probes
 *   before it sends traffic. It is the one route outside traffic may reach.
 * - `POST /__ske/queue` runs delivered jobs and reports one outcome per
 *   message (see the queue runner). It answers only requests carrying the
 *   platform's internal header.
 *
 * Anything else under the prefix is answered 404. The platform runs commands
 * and the scheduler as processes, so neither has a route.
 */

import { bridgeLog, exceptionRecord } from './logging.js';
import { safeEqual } from './maintenance.js';
import { runBatch, type QueueOptions, type QueueRecord } from './queue/runner.js';

export const PREFIX = '/__ske/';
export const HEALTH_PATH = '/__ske/health';
export const QUEUE_PATH = '/__ske/queue';
export const INTERNAL_HEADER = 'x-ske-internal';

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const NOT_FOUND: Reply = { status: 404, body: { error: 'not found' } };

/** Whether the path is one of the platform's. */
export function isInternalPath(path: string): boolean {
  return path === '/__ske' || path.startsWith(PREFIX);
}

/**
 * Whether a request carries the header only the platform's own requests do.
 *
 * The container's entry process strips this header from every request that
 * arrives from outside and refuses outside requests for `/__ske/*`, so this
 * is the second of two locks. It exists because the first lives in another
 * process: if the application is ever fronted by something else, this holds.
 */
export function isInternal(value: string | undefined): boolean {
  return value !== undefined && safeEqual(value, 'true');
}

export async function answerInternal(
  method: string,
  path: string,
  internal: string | undefined,
  readBody: () => Promise<Buffer>,
): Promise<Reply> {
  if (path === HEALTH_PATH) {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, body: { error: 'method not allowed' } };
    }
    return { status: 200, body: { status: 'ok' } };
  }

  // A missing or wrong header is answered as though the route did not
  // exist, as the platform answers it: a caller learns nothing about it.
  if (!isInternal(internal)) {
    return NOT_FOUND;
  }

  if (path === QUEUE_PATH) {
    if (method !== 'POST') {
      return { status: 405, body: { error: 'method not allowed' } };
    }
    const received = Date.now();
    return queue(await readBody(), received);
  }

  return NOT_FOUND;
}

/**
 * Runs a batch. Anything but a 200 with outcomes tells the platform nothing
 * ran, and it delivers every message of the batch again.
 */
async function queue(body: Buffer, received: number): Promise<Reply> {
  let payload: unknown;
  try {
    payload = JSON.parse(body.length > 0 ? body.toString('utf8') : '{}');
  } catch {
    return { status: 400, body: { error: 'the queue payload is not JSON' } };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 400, body: { error: 'the queue payload is not an object' } };
  }

  const { records, options } = payload as { records?: unknown; options?: unknown };
  try {
    const outcomes = await runBatch(
      Array.isArray(records) ? (records as QueueRecord[]) : [],
      typeof options === 'object' && options !== null ? (options as QueueOptions) : {},
      received,
    );
    return { status: 200, body: { processed: outcomes.length, outcomes } };
  } catch (error) {
    bridgeLog.error('The queue cannot run jobs', { exception: exceptionRecord(error) });
    return { status: 500, body: { error: String(error) } };
  }
}
