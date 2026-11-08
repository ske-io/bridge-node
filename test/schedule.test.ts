import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { schedule } from '@ske-io/bridge';

import { FIXTURES, runCli, type Run } from './helpers.ts';

const PLAIN = join(FIXTURES, 'plain');

/** The tasks a run ran, skipped and failed, from its log records. */
function outcome(run: Run) {
  const pick = (pattern: RegExp) =>
    run.logs.flatMap((log) => {
      const match = pattern.exec(String(log.message));
      return match ? [match[1] as string] : [];
    });
  return {
    ran: pick(/^Ran (\S+) in/),
    skipped: pick(/^Skipped (\S+): maintenance/),
    failed: pick(/^Scheduled task (\S+) failed/),
  };
}

async function ranAt(at: string, env: Record<string, string> = {}): Promise<string[]> {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: at, ...env });
  assert.equal(run.code, 0, run.stderr);
  return outcome(run).ran;
}

const ALWAYS = ['every-minute', 'every-thirty-seconds', 'at-second-ten', 'runs-in-maintenance', 'slow', 'fails-when-asked'];

test('a run executes the tasks due in the scheduled minute, in order, and awaits them', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: '2026-03-04T10:15:42Z' });
  assert.equal(run.code, 0, run.stderr);
  // Wednesday 10:15 UTC: every minute, and quarter past.
  assert.deepEqual(outcome(run).ran, ['every-minute', 'quarter-past', ...ALWAYS.slice(1)]);
  assert.match(run.stdout, /slow finished/);
  // Every line is a JSON record on stderr.
  assert.equal(run.logs.length, run.stderr.trim().split('\n').length);
});

test('due-ness is by the minute: hourly at the top of the hour, not a minute later', async () => {
  assert.ok((await ranAt('2026-03-04T10:00:00Z')).includes('hourly'));
  assert.ok(!(await ranAt('2026-03-04T10:01:00Z')).includes('hourly'));
  // Seconds and fractions of the scheduled time don't change the minute.
  assert.ok((await ranAt('2026-03-04T10:00:59.999+00:00')).includes('hourly'));
  // An offset is honoured: 12:00 at +02:00 is 10:00 UTC.
  assert.ok((await ranAt('2026-03-04T12:00:00+02:00')).includes('hourly'));
});

test('a task with a time zone is due at its local time, across daylight saving', async () => {
  // 09:00 in Paris is 08:00 UTC in winter and 07:00 UTC in summer.
  assert.ok((await ranAt('2026-01-15T08:00:00Z')).includes('paris-nine'));
  assert.ok(!(await ranAt('2026-01-15T09:00:00Z')).includes('paris-nine'));
  assert.ok((await ranAt('2026-07-15T07:00:00Z')).includes('paris-nine'));
  assert.ok(!(await ranAt('2026-07-15T08:00:00Z')).includes('paris-nine'));
});

test('when clocks go back the repeated local minute is due twice; when they go forward the skipped one never is', async () => {
  // New York, 2026-11-01: 01:30 happens at 05:30 UTC (EDT) and 06:30 UTC (EST).
  assert.ok((await ranAt('2026-11-01T05:30:00Z')).includes('new-york-0130'));
  assert.ok((await ranAt('2026-11-01T06:30:00Z')).includes('new-york-0130'));
  // New York, 2026-03-08: 02:00 jumps to 03:00, so 02:30 never happens.
  for (const at of ['2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z']) {
    assert.ok(!(await ranAt(at)).includes('new-york-0230'), at);
  }
  assert.ok((await ranAt('2026-03-09T06:30:00Z')).includes('new-york-0230'));
});

test('day names, and either day field when both are restricted', async () => {
  assert.ok((await ranAt('2026-03-06T12:00:00Z')).includes('weekday-noon')); // Friday
  assert.ok(!(await ranAt('2026-03-07T12:00:00Z')).includes('weekday-noon')); // Saturday
  assert.ok((await ranAt('2026-04-01T00:00:00Z')).includes('first-or-monday')); // the 1st, a Wednesday
  assert.ok((await ranAt('2026-04-06T00:00:00Z')).includes('first-or-monday')); // a Monday
  assert.ok(!(await ranAt('2026-04-07T00:00:00Z')).includes('first-or-monday'));
});

test('nothing due is a debug line, not an info one', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'nothing-due'), { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.logs.map((log) => [log.level_name, log.message]), [['DEBUG', 'Nothing is due']]);
});

test('a second-level task runs once a minute with a warning naming it', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z' });
  const warnings = run.logs.filter((log) => log.level_name === 'WARNING').map((log) => String(log.message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /more than once a minute.*every-thirty-seconds \(\*\/30 \* \* \* \* \*\)/);
  assert.equal(outcome(run).ran.filter((name) => name === 'every-thirty-seconds').length, 1);
});

test('in maintenance mode only tasks marked to run anyway run', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z', MAINTENANCE_MODE: 'true' });
  assert.equal(run.code, 0);
  const { ran, skipped } = outcome(run);
  assert.deepEqual(ran, ['runs-in-maintenance']);
  assert.ok(skipped.includes('every-minute') && skipped.includes('slow'));
});

test('a failing task does not stop the others, and the run exits non-zero', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z', FAIL_TASK: '1' });
  assert.equal(run.code, 1);
  const { ran, failed } = outcome(run);
  assert.deepEqual(failed, ['fails-when-asked']);
  assert.ok(ran.includes('slow') && ran.includes('every-minute'));
  const failure = run.logs.find((log) => log.level_name === 'ERROR');
  assert.equal(failure?.context.exception.message, 'the task broke');
  assert.match(failure?.context.exception.file, /schedule\.mjs:\d+$/);
});

test('without SKE_SCHEDULED_AT the clock decides; an unreadable one is warned about', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: 'yesterday' });
  assert.equal(run.code, 0);
  assert.ok(run.logs.some((log) => log.level_name === 'WARNING' && /SKE_SCHEDULED_AT/.test(log.message)));
  assert.ok(outcome(run).ran.includes('every-minute'));
  const noOffset = await runCli(['schedule', 'schedule.mjs'], PLAIN, { SKE_SCHEDULED_AT: '2026-03-04T10:00:00' });
  assert.ok(noOffset.logs.some((log) => /SKE_SCHEDULED_AT/.test(log.message)));
});

test('the entry comes from package.json, and a CommonJS entry shares the schedule', async () => {
  const configured = await runCli(['schedule'], join(FIXTURES, 'configured'), { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z' });
  assert.equal(configured.code, 0, configured.stderr);
  assert.deepEqual(outcome(configured).ran, ['configured-task']);

  const cjs = await runCli(['schedule', 'schedule.cjs'], join(FIXTURES, 'cjs'), { SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z' });
  assert.equal(cjs.code, 0, cjs.stderr);
  assert.deepEqual(outcome(cjs).ran, ['from-commonjs']);
});

test('no configured entry exits 0; a missing or broken entry exits non-zero', async () => {
  const none = await runCli(['schedule'], join(FIXTURES, 'broken'));
  assert.equal(none.code, 0);
  assert.match(none.stderr, /No schedule entry/);

  const missing = await runCli(['schedule', 'nope.js'], join(FIXTURES, 'broken'));
  assert.equal(missing.code, 1);

  const broken = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'broken'));
  assert.equal(broken.code, 1);
  assert.equal(broken.logs.at(-1)?.context.exception.message, 'the entry is broken');
});

test('off the platform the command still runs, with readable logs', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], PLAIN, {
    SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z',
    SKE_PROJECT_TYPE: '',
    SKE_ENVIRONMENT: '',
  });
  assert.equal(run.code, 0);
  assert.match(run.stderr, /^INFO Ran every-minute in \d+ms$/m);
  assert.deepEqual(run.logs, []);
});

test('schedule() refuses a bad expression, an unknown time zone or a taken name when the app loads', () => {
  assert.throws(() => schedule('bad-cron', '61 * * * *', () => undefined), /not a cron expression/);
  assert.throws(() => schedule('bad-fields', '* * *', () => undefined), /5 fields/);
  assert.throws(() => schedule('bad-zone', '* * * * *', () => undefined, { timeZone: 'Mars/Olympus' }), RangeError);
  schedule('taken', '* * * * *', () => undefined);
  assert.throws(() => schedule('taken', '* * * * *', () => undefined), /already defined/);
});

test('the command refuses unknown arguments', async () => {
  const run = await runCli(['run'], PLAIN);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Usage: ske-bridge schedule/);
});

const LOCAL = { SKE_PROJECT_TYPE: '', SKE_ENVIRONMENT: '', SKE_SCHEDULED_AT: '2026-03-04T10:01:00Z' };

test('off the platform the run waits for the jobs its tasks dispatched, and the jobs they dispatch', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'local-jobs'), LOCAL);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), ['parent ran', 'child ran 1']);
});

test('off the platform a delayed job is waited for too', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'local-jobs'), { ...LOCAL, DELAYED_JOB: '1' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n').sort(), ['child ran 1', 'child ran 2', 'parent ran']);
});

test('off the platform a failing dispatched job fails the run', async () => {
  const run = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'local-jobs'), { ...LOCAL, FAIL_JOB: '1' });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /broken.*failed[\s\S]*the job broke/);
  assert.match(run.stdout, /child ran 1/);
});

test('off the platform a job that would run after the wait ends fails the run at once, named', async () => {
  const started = Date.now();
  const run = await runCli(['schedule', 'schedule.mjs'], join(FIXTURES, 'local-jobs'), { ...LOCAL, LATE_JOB: '1' });
  assert.equal(run.code, 1);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  assert.match(run.stderr, /child.*not run/);
  assert.match(run.stdout, /child ran 1/);
});
