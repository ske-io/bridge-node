/**
 * Sends job messages to the environment's SQS queues.
 *
 * The platform sets `SQS_PREFIX` and `SQS_SUFFIX`, and a queue's URL is
 * `{SQS_PREFIX}/{name}{SQS_SUFFIX}`. The default queue is `SQS_QUEUE`, or
 * `default`; `SQS_QUEUES` lists every queue the environment has. The region
 * is `AWS_REGION`, else `AWS_DEFAULT_REGION`, and credentials come from the
 * SDK's default chain, which on the platform is the function's role, session
 * token included.
 *
 * The AWS SDK is loaded on the first send, so a process that never
 * dispatches never loads it.
 */

import { env } from '../env.js';

/** SQS's longest delivery delay, in seconds. */
export const MAX_DELAY = 900;

type Sdk = typeof import('@aws-sdk/client-sqs');

let sdk: Promise<Sdk> | undefined;
const clients = new Map<string, InstanceType<Sdk['SQSClient']>>();

/** The queue a job goes to, by name: the default one when none is given. */
export function queueName(requested: string | undefined): string {
  const name = requested ?? env('SQS_QUEUE') ?? 'default';
  const known = env('SQS_QUEUES')
    ?.split(',')
    .map((queue) => queue.trim())
    .filter((queue) => queue !== '');
  if (known !== undefined && known.length > 0 && !known.includes(name)) {
    throw new Error(`The environment has no queue named ${JSON.stringify(name)}; its queues are ${known.join(', ')}`);
  }
  return name;
}

export function queueUrl(name: string): string {
  const prefix = env('SQS_PREFIX');
  if (prefix === undefined) {
    throw new Error('SQS_PREFIX is not set, so there is no queue to send the job to');
  }
  return `${prefix.replace(/\/+$/, '')}/${name}${env('SQS_SUFFIX') ?? ''}`;
}

export async function sendMessage(queue: string, body: string, delaySeconds: number): Promise<void> {
  const url = queueUrl(queue);
  sdk ??= import('@aws-sdk/client-sqs').catch((cause: unknown) => {
    sdk = undefined;
    throw new Error('Sending jobs needs the package @aws-sdk/client-sqs', { cause });
  });
  const { SQSClient, SendMessageCommand } = await sdk;

  const region = env('AWS_REGION') ?? env('AWS_DEFAULT_REGION') ?? '';
  let client = clients.get(region);
  if (client === undefined) {
    client = new SQSClient(region === '' ? {} : { region });
    clients.set(region, client);
  }

  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      ...(delaySeconds > 0 ? { DelaySeconds: delaySeconds } : {}),
    }),
  );
}
