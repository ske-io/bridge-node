/**
 * What the platform should do with one delivered message now that its job
 * has run, or could not.
 *
 * Deleting, releasing and failing all need the queue's receipt for the
 * delivery, which only the platform holds, so the bridge states the decision
 * and the platform carries it out:
 *
 * - deleted: the job is done; the message is acknowledged.
 * - released: deliver it again, after `release_delay` seconds. The release
 *   uses one of the job's tries, unless `keeps_tries` is set (with no
 *   delay): the job was not started, or was cut short, because its batch ran
 *   out of time, and the platform delivers the message again with its count
 *   of tries kept. `keeps_tries` is sent only when set.
 * - failed: the job failed for good. The package keeps no record of failed
 *   jobs, so every failure is also a dead letter: the platform keeps the
 *   message where it keeps failed messages, to inspect or send again.
 */

export interface JobOutcome {
  readonly message_id: string;
  readonly deleted: boolean;
  readonly released: boolean;
  readonly release_delay: number | null;
  readonly failed: boolean;
  readonly dead_letter: boolean;
  readonly attempts: number;
  readonly error: string | null;
  readonly keeps_tries?: true;
}

export function deleted(messageId: string, attempts: number): JobOutcome {
  return { message_id: messageId, deleted: true, released: false, release_delay: null, failed: false, dead_letter: false, attempts, error: null };
}

/** A release that uses one of the job's tries, after `delay` seconds. */
export function released(messageId: string, attempts: number, delay: number, error: string | null): JobOutcome {
  return { message_id: messageId, deleted: false, released: true, release_delay: delay, failed: false, dead_letter: false, attempts, error };
}

/**
 * A release that keeps the job's tries: its batch ran out of time before it
 * started, or cut it short. It is delivered again at once.
 */
export function releasedForTime(messageId: string, attempts: number, error: string): JobOutcome {
  return {
    message_id: messageId,
    deleted: false,
    released: true,
    release_delay: null,
    failed: false,
    dead_letter: false,
    attempts,
    error,
    keeps_tries: true,
  };
}

export function failed(messageId: string, attempts: number, error: string): JobOutcome {
  return { message_id: messageId, deleted: false, released: false, release_delay: null, failed: true, dead_letter: true, attempts, error };
}
