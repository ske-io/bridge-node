/**
 * What the platform should do with one delivered message now that its job
 * has run, or could not.
 *
 * Deleting, releasing and failing all need the queue's receipt for the
 * delivery, which only the platform holds, so the bridge states the decision
 * and the platform carries it out:
 *
 * - deleted: the job is done; the message is acknowledged.
 * - released: deliver it again, after `release_delay` seconds.
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
}

export function deleted(messageId: string, attempts: number): JobOutcome {
  return { message_id: messageId, deleted: true, released: false, release_delay: null, failed: false, dead_letter: false, attempts, error: null };
}

export function released(messageId: string, attempts: number, delay: number | null, error: string | null): JobOutcome {
  return { message_id: messageId, deleted: false, released: true, release_delay: delay, failed: false, dead_letter: false, attempts, error };
}

export function failed(messageId: string, attempts: number, error: string): JobOutcome {
  return { message_id: messageId, deleted: false, released: false, release_delay: null, failed: true, dead_letter: true, attempts, error };
}
