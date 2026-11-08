import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { defineJob, dispatch } from '@ske-io/bridge';

import { captureStderr, PLATFORM, records, serve, useEnv } from './helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Sent {
  headers: IncomingHttpHeaders;
  body: { QueueUrl: string; MessageBody: string; DelaySeconds?: number };
}

/** A stand-in for SQS's JSON API that records each SendMessage call. */
const sent: Sent[] = [];
const sqs = await serve((req, res) => {
  let text = '';
  req.on('data', (chunk: Buffer) => (text += chunk.toString()));
  req.on('end', () => {
    const body = JSON.parse(text) as Sent['body'];
    sent.push({ headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
    res.end(
      JSON.stringify({
        MessageId: 'sqs-message-1',
        MD5OfMessageBody: createHash('md5').update(body.MessageBody).digest('hex'),
      }),
    );
  });
});

/** Waits until `done()` holds, for at most a second. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 1000; waited += 5) await sleep(5);
}

function onPlatform(extra: Record<string, string> = {}) {
  sent.length = 0;
  useEnv({
    ...PLATFORM,
    SQS_PREFIX: `${sqs}/123456789012/`,
    SQS_SUFFIX: '-production',
    SQS_QUEUE: undefined,
    SQS_QUEUES: undefined,
    AWS_REGION: 'eu-west-3',
    AWS_DEFAULT_REGION: undefined,
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'session-token',
    ...extra,
  });
}

test('off the platform a job runs on the next tick with a JSON copy of its payload', async () => {
  useEnv({});
  const runs: unknown[] = [];
  defineJob('j-local', (payload, job) => {
    runs.push([payload, job.name, job.attempts]);
  });

  const id = await dispatch('j-local', { at: new Date('2026-01-02T03:04:05Z'), skip: undefined });
  assert.match(id, UUID);
  assert.deepEqual(runs, []);

  await until(() => runs.length > 0);
  assert.deepEqual(runs, [[{ at: '2026-01-02T03:04:05.000Z' }, 'j-local', 1]]);
});

test('off the platform a delayed job waits for its delay', async () => {
  useEnv({});
  let ranAt = 0;
  const job = defineJob('j-delayed', () => {
    ranAt = Date.now();
  });
  const start = Date.now();
  await job.dispatch(null, { delay: 1 });
  await sleep(1300);
  assert.ok(ranAt - start >= 950, `ran after ${ranAt - start}ms`);
});

test('a job failing on the next tick is logged, not thrown at the process', async () => {
  useEnv({});
  defineJob('j-local-fails', () => {
    throw new Error('local failure');
  });
  const lines = await captureStderr(async () => {
    await dispatch('j-local-fails', {});
    await sleep(50);
  });
  assert.match(lines.join('\n'), /j-local-fails.*failed[\s\S]*local failure/);
});

test('SKE_QUEUE_SYNC=1 runs the job before dispatch resolves, and its error rejects dispatch', async () => {
  useEnv({ SKE_QUEUE_SYNC: '1' });
  const runs: unknown[] = [];
  defineJob('j-sync', (payload) => {
    runs.push(payload);
  });
  await dispatch('j-sync', { n: 1 });
  assert.deepEqual(runs, [{ n: 1 }]);

  defineJob('j-sync-fails', () => {
    throw new Error('sync failure');
  });
  await assert.rejects(dispatch('j-sync-fails', {}), /sync failure/);
});

test('dispatch rejects an undefined job, a bad delay or a payload that is not JSON', async () => {
  useEnv({});
  defineJob('j-checks', () => undefined);
  await assert.rejects(dispatch('j-nope', {}), /No job named "j-nope"/);
  await assert.rejects(dispatch('j-checks', {}, { delay: 901 }), RangeError);
  await assert.rejects(dispatch('j-checks', {}, { delay: 1.5 }), RangeError);
  await assert.rejects(dispatch('j-checks', { n: 1n }), TypeError);
  assert.throws(() => defineJob('j-checks', () => undefined), /already defined/);
});

test('on the platform dispatch sends the job body to the default queue', async () => {
  onPlatform();
  let ran = false;
  defineJob('j-send', () => {
    ran = true;
  });

  const id = await dispatch('j-send', { user: 7 });

  assert.equal(ran, false);
  assert.equal(sent.length, 1);
  const [{ headers, body }] = sent as [Sent];
  assert.equal(headers['x-amz-target'], 'AmazonSQS.SendMessage');
  assert.equal(body.QueueUrl, `${sqs}/123456789012/default-production`);
  assert.deepEqual(JSON.parse(body.MessageBody), { job: 'j-send', payload: { user: 7 }, id });
  assert.match(id, UUID);
  assert.equal(body.DelaySeconds, undefined);
  // The SDK's credential chain, session token included, in the region.
  assert.match(String(headers.authorization), /Credential=AKIDEXAMPLE\/\d{8}\/eu-west-3\/sqs\/aws4_request/);
  assert.equal(headers['x-amz-security-token'], 'session-token');
});

test('on the platform the delay, SQS_QUEUE and a named queue are honoured', async () => {
  onPlatform({ SQS_QUEUE: 'jobs', SQS_QUEUES: 'jobs,emails' });
  defineJob('j-route', () => undefined);

  await dispatch('j-route', 1, { delay: 45 });
  await dispatch('j-route', 2, { queue: 'emails' });
  await assert.rejects(dispatch('j-route', 3, { queue: 'reports' }), /no queue named "reports"/);

  assert.deepEqual(
    sent.map(({ body }) => [body.QueueUrl.replace(sqs, ''), body.DelaySeconds]),
    [
      ['/123456789012/jobs-production', 45],
      ['/123456789012/emails-production', undefined],
    ],
  );
});

test('on the platform SKE_QUEUE_SYNC does not run jobs inline, and AWS_DEFAULT_REGION is the fallback region', async () => {
  onPlatform({ SKE_QUEUE_SYNC: '1', AWS_REGION: undefined as unknown as string, AWS_DEFAULT_REGION: 'ap-south-1' });
  let ran = false;
  defineJob('j-sync-platform', () => {
    ran = true;
  });
  await dispatch('j-sync-platform', {});
  assert.equal(ran, false);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0]?.headers.authorization), /\/ap-south-1\/sqs\//);
});

test('a refused send rejects dispatch', async () => {
  onPlatform({ SQS_PREFIX: 'http://127.0.0.1:1/123456789012' });
  defineJob('j-refused', () => undefined);
  const lines = await captureStderr(() => assert.rejects(dispatch('j-refused', {})));
  assert.deepEqual(records(lines), []);
});
