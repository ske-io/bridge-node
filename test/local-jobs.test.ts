/**
 * Jobs dispatched off the platform, and the drain `ske-bridge schedule` runs
 * before it exits. The drain's wait is a minute in the command, so it is
 * tested below the command's interface, with short waits.
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { defineJob, dispatch } from '@ske-io/bridge';

import { captureStderr, useEnv } from './helpers.ts';

// The modules inside the built package, from build/test where this runs.
const { startLocalJobs, settleLocalJobs } = (await import(new URL('../../dist/esm/queue/jobs.js', import.meta.url).href)) as typeof import('../dist/esm/queue/jobs.js');

/** The package's process-wide state. */
const state = () => (globalThis as unknown as Record<symbol, Record<string, unknown>>)[Symbol.for('@ske-io/bridge')] as Record<string, unknown>;

/** Every array and map the state holds, with its size. */
function retained(): number {
  return Object.values(state()).reduce<number>((total, value) => {
    if (Array.isArray(value)) return total + value.length;
    if (value instanceof Map && value !== state().jobs && value !== state().schedule) return total + value.size;
    return total;
  }, 0);
}

function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

test('a long-running app keeps nothing of the local jobs that failed', async () => {
  useEnv({});
  defineJob('l-fails', () => {
    throw new Error('local failure');
  });
  await captureStderr(async () => {
    for (let i = 0; i < 1000; i++) await dispatch('l-fails', { i });
    await sleep(50);
  });
  assert.equal(retained(), 0);
});

test("the drain reports the failures of its own session only, and keeps nothing after", async () => {
  useEnv({});
  defineJob('l-fails-before', () => {
    throw new Error('before the drain');
  });
  defineJob('l-fails-during', () => {
    throw new Error('during the drain');
  });
  await captureStderr(async () => {
    await dispatch('l-fails-before', {});
    await sleep(20);
    startLocalJobs();
    await dispatch('l-fails-during', {});
    const result = await settleLocalJobs(5000);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0] as string, /^l-fails-during \[/);
  });
  assert.equal(retained(), 0);
});

test('a job that holds the event loop past the wait is reported late, by name', async () => {
  useEnv({});
  defineJob('l-blocks', () => busy(150));
  startLocalJobs();
  await dispatch('l-blocks', {});
  const result = await settleLocalJobs(20);
  assert.deepEqual(result.failed, []);
  assert.equal(result.late.length, 1);
  assert.match(result.late[0] as string, /^l-blocks \[/);
  assert.equal(retained(), 0);
});

test('jobs that finish within the wait are neither late nor failed', async () => {
  useEnv({});
  defineJob('l-quick', async () => {
    await sleep(10);
  });
  startLocalJobs();
  await dispatch('l-quick', {});
  const result = await settleLocalJobs(5000);
  assert.deepEqual([result.failed, result.late, result.unfinished], [[], [], []]);
});

test('a drain session cannot open while another is open', async () => {
  useEnv({});
  startLocalJobs();
  assert.throws(() => startLocalJobs(), /already/);
  await settleLocalJobs(10);
  startLocalJobs();
  await settleLocalJobs(10);
});

test("a job reports only to the session it was dispatched in: one still running when it closes is unfinished there, and its failure later reaches no other session", async () => {
  useEnv({});
  defineJob('l-slow-fails', async () => {
    await sleep(100);
    throw new Error('late failure');
  });
  defineJob('l-ok', () => undefined);

  await captureStderr(async () => {
    startLocalJobs();
    await dispatch('l-slow-fails', {});
    const first = await settleLocalJobs(20);
    assert.deepEqual(first.failed, []);
    assert.equal(first.unfinished.length, 1);
    assert.match(first.unfinished[0] as string, /^l-slow-fails \[/);

    startLocalJobs();
    await dispatch('l-ok', {});
    await sleep(150);
    const second = await settleLocalJobs(1000);
    assert.deepEqual([second.failed, second.late, second.unfinished], [[], [], []]);
  });
  assert.equal(retained(), 0);
});

test("a job's descendants belong to its session: one dispatched after that session closed reaches no newer session", async () => {
  useEnv({});
  defineJob('l-orphan-child', () => {
    throw new Error('child of a closed session');
  });
  defineJob('l-slow-parent', async () => {
    await sleep(30);
    await dispatch('l-orphan-child', {});
  });

  await captureStderr(async () => {
    startLocalJobs();
    await dispatch('l-slow-parent', {});
    const first = await settleLocalJobs(5);
    assert.equal(first.unfinished.length, 1);

    startLocalJobs();
    await sleep(80);
    const second = await settleLocalJobs(1000);
    assert.deepEqual([second.failed, second.late, second.unfinished], [[], [], []]);
  });
  assert.equal(retained(), 0);
});
