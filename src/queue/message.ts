/**
 * The body of one queued job: UTF-8 JSON
 *
 *     {"job":"send-welcome-mail","payload":{...},"id":"<uuid>"}
 *
 * `job` is the name the handler was defined with, `payload` the JSON value
 * given to dispatch(), and `id` a UUID made once by dispatch() and kept on
 * every delivery of the message.
 */

export interface JobMessage {
  readonly job: string;
  readonly payload: unknown;
  readonly id: string;
}

export class InvalidMessage extends Error {
  override name = 'InvalidMessage';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeMessage(message: JobMessage): string {
  return JSON.stringify({ job: message.job, payload: message.payload, id: message.id });
}

/** The message a delivered body holds; throws InvalidMessage when it holds none. */
export function decodeMessage(body: unknown): JobMessage {
  if (typeof body !== 'string') {
    throw new InvalidMessage('the body is not text');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidMessage('the body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidMessage('the body is not a JSON object');
  }

  const { job, payload, id } = parsed as Record<string, unknown>;
  if (typeof job !== 'string' || job === '') {
    throw new InvalidMessage('"job" is not a job name');
  }
  if (!('payload' in parsed)) {
    throw new InvalidMessage('"payload" is missing');
  }
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new InvalidMessage('"id" is not a UUID');
  }
  return { job, payload, id };
}
