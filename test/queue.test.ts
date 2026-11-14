import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { defineJob, type JobContext } from '@ske-io/bridge';
import { withBridge } from '@ske-io/bridge/http';

import { batch, FIXTURES, INTERNAL, PLATFORM, record, records, serve, useEnv } from './helpers.ts';

useEnv(PLATFORM);
const url = await serve(withBridge((_req, res) => res.end('app')));

async function deliver(body: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${url}/__ske/queue`, { method: 'POST', headers: INTERNAL, body });
  return { status: response.status, json: await response.json() };
}

function outcome(messageId: string, fields: Partial<Record<string, unknown>>) {
  return {
    message_id: messageId,
    deleted: false,
    released: false,
    release_delay: null,
    failed: false,
    dead_letter: false,
    attempts: 1,
    error: null,
    ...fields,
  };
}

const ID = '0d6c8f5e-2b1a-4c3d-8e9f-a1b2c3d4e5f6';

test('a job that resolves is deleted, and gets its JSON payload, id, name and attempt', async () => {
  const seen: Array<[unknown, Omit<JobContext, 'signal'>]> = [];
  defineJob('q-ok', (payload, job) => {
    seen.push([payload, { id: job.id, name: job.name, attempts: job.attempts }]);
  });

  const { status, json } = await deliver(batch([record('m1', 'q-ok', { user: 7, tags: ['a'] }, 2, ID)], { tries: 3 }));

  assert.equal(status, 200);
  assert.deepEqual(json, { processed: 1, outcomes: [outcome('m1', { deleted: true, attempts: 2 })] });
  assert.deepEqual(seen, [[{ user: 7, tags: ['a'] }, { id: ID, name: 'q-ok', attempts: 2 }]]);
});

test('attempts default to 1 when the delivery has none or zero', async () => {
  defineJob('q-attempts', () => undefined);
  const { json } = await deliver(batch([record('m1', 'q-attempts', null), record('m2', 'q-attempts', null, 0)]));
  assert.deepEqual(
    json.outcomes.map((o: any) => o.attempts),
    [1, 1],
  );
});

test('a failing job is released after the backoff while tries are left, then failed as a dead letter', async () => {
  defineJob('q-throws', () => {
    throw new TypeError('boom');
  });

  const first = await deliver(batch([record('m1', 'q-throws', {}, 1)], { tries: 3, backoff: 30 }));
  assert.deepEqual(first.json.outcomes, [outcome('m1', { released: true, release_delay: 30, attempts: 1, error: 'TypeError: boom' })]);

  const second = await deliver(batch([record('m1', 'q-throws', {}, 2)], { tries: 3 }));
  assert.deepEqual(second.json.outcomes, [outcome('m1', { released: true, release_delay: 0, attempts: 2, error: 'TypeError: boom' })]);

  const last = await deliver(batch([record('m1', 'q-throws', {}, 3)], { tries: 3, backoff: 30 }));
  assert.deepEqual(last.json.outcomes, [outcome('m1', { failed: true, dead_letter: true, attempts: 3, error: 'TypeError: boom' })]);
});

test('a rejected promise fails like a throw, and tries default to 1', async () => {
  defineJob('q-rejects', async () => {
    throw new Error('nope');
  });
  const { json } = await deliver(batch([record('m1', 'q-rejects', {})], { backoff: 9 }));
  assert.deepEqual(json.outcomes, [outcome('m1', { failed: true, dead_letter: true, error: 'Error: nope' })]);
});

test('a delivery already past its tries fails without running', async () => {
  let ran = false;
  defineJob('q-past-tries', () => {
    ran = true;
  });
  const { json } = await deliver(batch([record('m1', 'q-past-tries', {}, 4)], { tries: 3 }));
  assert.equal(ran, false);
  assert.equal(json.outcomes[0].failed, true);
  assert.equal(json.outcomes[0].dead_letter, true);
  assert.equal(json.outcomes[0].attempts, 4);
});

test('an unreadable body, a missing field, a bad id or an unknown job fails as a dead letter', async () => {
  defineJob('q-known', () => undefined);
  const bodies = [
    'not json',
    '[]',
    JSON.stringify({ payload: {}, id: ID }),
    JSON.stringify({ job: '', payload: {}, id: ID }),
    JSON.stringify({ job: 'q-known', id: ID }),
    JSON.stringify({ job: 'q-known', payload: {}, id: 'not-a-uuid' }),
    JSON.stringify({ job: 'q-known', payload: {} }),
    JSON.stringify({ job: 'q-missing', payload: {}, id: ID }),
  ];
  const { json } = await deliver(
    batch(
      bodies.map((body, i) => ({ message_id: `m${i}`, body, attempts: 1 })),
      { tries: 5 },
    ),
  );
  assert.equal(json.processed, bodies.length);
  for (const [i, o] of json.outcomes.entries()) {
    assert.equal(o.message_id, `m${i}`);
    assert.deepEqual([o.deleted, o.released, o.failed, o.dead_letter], [false, false, true, true], bodies[i]);
    assert.equal(typeof o.error, 'string');
  }
});

test('every record of a batch gets exactly one outcome, in order', async () => {
  defineJob('q-batch-ok', () => undefined);
  defineJob('q-batch-bad', () => {
    throw new Error('bad');
  });
  const { json } = await deliver(
    batch([record('a', 'q-batch-ok', 1), record('b', 'q-batch-bad', 2), record('c', 'q-batch-ok', 3)], { tries: 2, backoff: 4 }),
  );
  assert.equal(json.processed, 3);
  assert.deepEqual(
    json.outcomes.map((o: any) => [o.message_id, o.deleted, o.released, o.failed]),
    [
      ['a', true, false, false],
      ['b', false, true, false],
      ['c', true, false, false],
    ],
  );
});

test('a job past its time limit is aborted and follows the tries policy, never acknowledged', async () => {
  let aborted = false;
  defineJob('q-slow', (_payload, job) => {
    return new Promise<void>((resolve) => {
      job.signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      });
    });
  });

  // A 2s queue timeout leaves the job max(1, 2 - min(5, 1)) = 1s.
  const started = Date.now();
  const first = await deliver(batch([record('m1', 'q-slow', {}, 1)], { timeout: 2, tries: 2, backoff: 7, deadline_ms: Date.now() + 60_000 }));
  const took = Date.now() - started;
  assert.ok(took >= 900 && took < 1900, `took ${took}ms`);
  assert.equal(aborted, true);
  assert.deepEqual(
    [first.json.outcomes[0].deleted, first.json.outcomes[0].released, first.json.outcomes[0].release_delay],
    [false, true, 7],
  );
  assert.match(first.json.outcomes[0].error, /time limit/);

  const last = await deliver(batch([record('m1', 'q-slow', {}, 2)], { timeout: 2, tries: 2, backoff: 7, deadline_ms: Date.now() + 60_000 }));
  assert.deepEqual([last.json.outcomes[0].deleted, last.json.outcomes[0].failed, last.json.outcomes[0].dead_letter], [false, true, true]);
});

test('records reached after the batch deadline are released unstarted, with no failure counted', async () => {
  let ran = 0;
  defineJob('q-late', () => {
    ran++;
  });
  const { json } = await deliver(batch([record('m1', 'q-late', {}, 3), record('m2', 'q-late', {}, 3)], { tries: 3, deadline_ms: Date.now() - 1000 }));
  assert.equal(ran, 0);
  assert.deepEqual(
    json.outcomes.map((o: any) => [o.message_id, o.released, o.release_delay, o.keeps_tries, o.failed]),
    [
      ['m1', true, null, true, false],
      ['m2', true, null, true, false],
    ],
  );
});

test('a counted release has an explicit delay and does not say it keeps tries', async () => {
  defineJob('q-counted', () => {
    throw new Error('again');
  });
  const { json } = await deliver(batch([record('m1', 'q-counted', {}, 1)], { tries: 2 }));
  assert.equal(json.outcomes[0].release_delay, 0);
  assert.equal('keeps_tries' in json.outcomes[0], false);
});

/** A job that waits until it is told to stop. */
const waitsForAbort = (_payload: unknown, job: JobContext) => new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve()));

test("a first job that runs to the batch's deadline owns that timeout and uses a try", async () => {
  defineJob('q-first-overrun', waitsForAbort);

  // As on the platform: the deadline is the queue's 2s timeout less the
  // platform's own margin for answering, so the batch has 1.8s less
  // min(5s, 0.9s), 0.9s, just under the job's own 1s. That is its full time.
  const first = await deliver(batch([record('m1', 'q-first-overrun', {}, 1)], { timeout: 2, tries: 2, backoff: 7, deadline_ms: Date.now() + 1800 }));
  assert.deepEqual([first.json.outcomes[0].released, first.json.outcomes[0].release_delay, 'keeps_tries' in first.json.outcomes[0]], [true, 7, false]);

  // 2s left keeps back 1s: the batch stops 1s from now, well before the
  // job's own 55s limit, but nothing else used the time: it fails on its
  // last try.
  const started = Date.now();
  const last = await deliver(batch([record('m1', 'q-first-overrun', {}, 1)], { timeout: 60, tries: 1, deadline_ms: Date.now() + 2000 }));
  const took = Date.now() - started;
  assert.ok(took >= 800 && took < 1900, `took ${took}ms`);
  assert.deepEqual([last.json.outcomes[0].failed, last.json.outcomes[0].dead_letter], [true, true]);
});

test('a later job cut short by earlier work in the batch is released keeping its tries, even on its last try', async () => {
  defineJob('q-cut-first', () => busy(500));
  defineJob('q-cut', waitsForAbort);

  // 3.6s left keeps back 1.8s: 1.8s for the batch, under the job's own 2s.
  // The first job takes 0.5s of it, so the second is cut short by the batch.
  const { json } = await deliver(
    batch([record('a', 'q-cut-first', {}, 1), record('b', 'q-cut', {}, 1)], { timeout: 4, tries: 1, deadline_ms: Date.now() + 3600 }),
  );
  assert.deepEqual(
    json.outcomes.map((o: any) => [o.message_id, o.deleted, o.released, o.release_delay, o.keeps_tries, o.failed]),
    [
      ['a', true, false, null, undefined, false],
      ['b', false, true, null, true, false],
    ],
  );
  assert.equal(json.outcomes[1].error, "stopped at the batch's deadline");
});

for (const [used, cut] of [
  [100, false],
  [400, true],
] as const) {
  test(`a later job is cut only when earlier work took more than the slack: ${used}ms used`, async () => {
    defineJob(`q-slack-first-${used}`, () => busy(used));
    defineJob(`q-slack-${used}`, waitsForAbort);

    // 4s left keeps back 2s: the batch has 2s, far under the job's own 55s,
    // so that is its full time, and the slack is a tenth of it, 200ms.
    const { json } = await deliver(
      batch([record('a', `q-slack-first-${used}`, {}, 1), record('b', `q-slack-${used}`, {}, 1)], { timeout: 60, tries: 1, deadline_ms: Date.now() + 4000 }),
    );
    const o = json.outcomes[1];
    if (cut) {
      assert.deepEqual([o.released, o.release_delay, o.keeps_tries, o.failed], [true, null, true, false]);
    } else {
      assert.deepEqual([o.released, o.failed, o.dead_letter, 'keeps_tries' in o], [false, true, true, false]);
    }
  });
}

/** Blocks the event loop for `ms`, as CPU-bound code does. */
function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

test('a handler that blocks past its time limit is never deleted, even though it returned', async () => {
  defineJob('q-blocks', () => busy(1500));
  defineJob('q-blocks-async', async () => {
    await Promise.resolve();
    busy(1500);
  });

  // A 2s queue timeout leaves the job 1s; the platform's deadline is far off,
  // so the job's own limit is the earlier one. 1.5s is past it, and short of
  // the watchdog's grace.
  for (const job of ['q-blocks', 'q-blocks-async']) {
    const first = await deliver(batch([record('m1', job, {}, 1)], { timeout: 2, tries: 2, backoff: 7, deadline_ms: Date.now() + 60_000 }));
    assert.deepEqual(
      [first.json.outcomes[0].deleted, first.json.outcomes[0].released, first.json.outcomes[0].release_delay],
      [false, true, 7],
      job,
    );
    assert.match(first.json.outcomes[0].error, /time limit/);

    const last = await deliver(batch([record('m1', job, {}, 2)], { timeout: 2, tries: 2, backoff: 7, deadline_ms: Date.now() + 60_000 }));
    assert.deepEqual([last.json.outcomes[0].deleted, last.json.outcomes[0].failed, last.json.outcomes[0].dead_letter], [false, true, true], job);
  }
});

test('a handler that blocks past the batch deadline after earlier work is released, never deleted', async () => {
  defineJob('q-blocks-cut-first', () => busy(400));
  defineJob('q-blocks-cut', () => busy(800));
  // 2s left keeps back 1s: the batch stops 1s from now, and the first job
  // takes 0.4s of it. The second blocks past the cutoff, and returns before
  // the watchdog's grace (half the 1s left to the platform's end) runs out.
  const { json } = await deliver(
    batch([record('a', 'q-blocks-cut-first', {}, 1), record('b', 'q-blocks-cut', {}, 1)], { timeout: 60, tries: 1, deadline_ms: Date.now() + 2000 }),
  );
  const o = json.outcomes[1];
  assert.deepEqual([o.deleted, o.released, o.release_delay, o.keeps_tries, o.failed], [false, true, null, true, false]);
});

test('without a deadline the batch has the timeout budget from arrival, and a job cut by it is released', async () => {
  defineJob('q-budget-first', () => busy(1200));
  defineJob('q-budget-second', (_payload, job) => new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve())));
  // A 4s timeout gives the batch 2s from arrival: the first job uses 1.2s of it.
  const { json } = await deliver(
    batch([record('a', 'q-budget-first', {}, 1), record('b', 'q-budget-second', {}, 1)], { timeout: 4, tries: 1 }),
  );
  assert.deepEqual(
    json.outcomes.map((o: any) => [o.message_id, o.deleted, o.released, o.release_delay, o.failed]),
    [
      ['a', true, false, null, false],
      ['b', false, true, null, false],
    ],
  );
  assert.equal(json.outcomes[1].keeps_tries, true);
});

test('without a deadline the first job is bounded by the batch budget too: time spent before it counts', async () => {
  // A 4s timeout gives the batch 2s from arrival. Reading a 1MB batch takes
  // part of it, so a handler taking the whole 2s ends past the cutoff: out
  // of time, never deleted. Reading the batch is not earlier work (it takes
  // far less than the 200ms slack), so the job owns the timeout and fails on
  // its last try.
  defineJob('q-budget-large', () => busy(2000));
  const payload = { blob: 'x'.repeat(1_000_000) };
  const { json } = await deliver(batch([record('m1', 'q-budget-large', payload, 1)], { timeout: 4, tries: 1 }));
  const o = json.outcomes[0];
  assert.deepEqual([o.deleted, o.released, o.failed, 'keeps_tries' in o], [false, false, true, false]);
  assert.match(o.error, /time limit/);
});

const { cutByBatch } = (await import(new URL('../../dist/esm/queue/runner.js', import.meta.url).href)) as typeof import('../dist/esm/queue/runner.js');

test('the cut rule boundary', () => {
  const table: Array<[left: number, own: number, whole: number, cut: boolean]> = [
    // Full time is the job's own 10s; the slack is 1s.
    [9000, 10_000, 20_000, false],
    [8999, 10_000, 20_000, true],
    // On the platform the batch is a little shorter than the job's own
    // limit: full time is the batch's 54s.
    [54_000, 55_000, 54_000, false],
    [53_000, 55_000, 54_000, false],
    [52_999, 55_000, 54_000, true],
    // A short batch: a tenth of it.
    [450, 55_000, 500, false],
    [449, 55_000, 500, true],
  ];
  for (const [left, own, whole, cut] of table) {
    assert.equal(cutByBatch(left, own, whole), cut, `${left}, ${own}, ${whole}`);
  }
});

/** Delivers [finishes, `job`] to the fixture app in a child process, and expects the watchdog to kill it. */
async function killedByWatchdog(job: string): Promise<void> {
  const child = spawn(process.execPath, [join(FIXTURES, 'never-yields', 'server.mjs')], { env: { ...process.env, ...PLATFORM } });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
  try {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    while (!/port (\d+)/.test(stdout)) await sleep(10);
    const port = /port (\d+)/.exec(stdout)?.[1];

    // A 2s timeout gives the job 1s, and the watchdog a grace after it that
    // ends before the platform's own timeout.
    const started = Date.now();
    const answer = fetch(`http://127.0.0.1:${port}/__ske/queue`, {
      method: 'POST',
      headers: INTERNAL,
      body: batch([record('a', 'finishes', {}), record('b', job, {})], { timeout: 2 }),
      signal: AbortSignal.timeout(5000),
    });
    // The connection drops with no answer: the platform counts the
    // invocation as failed and delivers both messages again.
    await assert.rejects(answer, (error: Error) => error.name !== 'TimeoutError');
    assert.equal(await exited, 'SIGKILL');
    const took = Date.now() - started;
    assert.ok(took < 2000, `killed after ${took}ms`);
    assert.match(stdout, /finishes ran/);
    const critical = records(stderr.split('\n')).find((log) => log.level_name === 'CRITICAL');
    assert.match(String(critical?.message), new RegExp(`${job}.*still running.*stopping the process`));
  } finally {
    child.kill('SIGKILL');
  }
}

test('a handler that never yields is stopped by the watchdog: the process is killed and nothing is acknowledged', async () => {
  await killedByWatchdog('spins');
});

test('a handler that yields but ignores its abort signal is stopped the same way, before the batch is answered', async () => {
  await killedByWatchdog('ignores-abort');
});

test('a handler that honours its abort signal and settles within the grace gets the normal timeout outcome', async () => {
  defineJob('q-honours-abort', (_payload, job) => {
    // Cleans up for a moment after the abort, then stops.
    return new Promise<void>((resolve) => job.signal.addEventListener('abort', () => setTimeout(resolve, 200)));
  });
  const started = Date.now();
  const { json } = await deliver(batch([record('m1', 'q-honours-abort', {}, 1)], { timeout: 2, tries: 2, backoff: 3, deadline_ms: Date.now() + 60_000 }));
  const took = Date.now() - started;
  // Answered once the handler settled, after its 1s limit and the cleanup.
  assert.ok(took >= 1150, `answered after ${took}ms`);
  assert.deepEqual([json.outcomes[0].deleted, json.outcomes[0].released, json.outcomes[0].release_delay], [false, true, 3]);
  assert.match(json.outcomes[0].error, /time limit/);
});

/** Starts the fixture app with `nodeArgs` in a child process; resolves once it listens. */
async function startApp(nodeArgs: string[]) {
  const child = spawn(process.execPath, nodeArgs, { env: { ...process.env, ...PLATFORM } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  for (let waited = 0; !/port (\d+)/.test(stdout); waited += 10) {
    if (waited > 5000 || child.exitCode !== null) throw new Error(`the app did not start: ${stderr}`);
    await sleep(10);
  }
  const port = /port (\d+)/.exec(stdout)?.[1];
  return { child, port, stderr: () => stderr };
}

/** Runs one healthy job in the app and checks it is acknowledged and the app lives on. */
async function healthyJobKeepsAppAlive(nodeArgs: string[]): Promise<string> {
  const app = await startApp(nodeArgs);
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/__ske/queue`, {
      method: 'POST',
      headers: INTERNAL,
      body: batch([record('a', 'finishes', {})], { timeout: 10 }),
    });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { outcomes: Array<{ deleted: boolean }> };
    assert.equal(reply.outcomes[0]?.deleted, true);
    // The watchdog's thread is up by now, or has failed to start.
    await sleep(500);
    assert.equal(app.child.exitCode, null, `the app exited: ${app.stderr()}`);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/up`)).status, 200);
    return app.stderr();
  } finally {
    app.child.kill('SIGKILL');
  }
}

const SERVER = join(FIXTURES, 'never-yields', 'server.mjs');

test("the watchdog doesn't depend on the app's Node flags: an app started with --input-type=module runs jobs and lives on", async () => {
  await healthyJobKeepsAppAlive(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SERVER).href)});`]);
});

test("a watchdog that can't start never takes the app down: it is logged, and jobs keep the in-loop time limit", async () => {
  // The permission model without --allow-worker refuses worker threads. The
  // app still needs to listen, which newer Nodes restrict too.
  // Older Nodes name the permission model --experimental-permission.
  const flags = process.allowedNodeEnvironmentFlags;
  const permission = flags.has('--permission') ? '--permission' : '--experimental-permission';
  const allowNet = flags.has('--allow-net') ? ['--allow-net'] : [];
  const stderr = await healthyJobKeepsAppAlive([permission, '--allow-fs-read=*', ...allowNet, SERVER]);
  const error = records(stderr.split('\n')).find((log) => log.level_name === 'ERROR');
  assert.match(String(error?.message), /watchdog.*could not start/i);
});
