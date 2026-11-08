/**
 * Due-ness against the `cron` package's CronTime, which @nestjs/schedule
 * runs `@Cron` expressions with: the same expression must be due in the
 * same minutes. This tests the parser below the command's interface, since
 * comparing thousands of minutes through `ske-bridge schedule` would take a
 * process per minute.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CronTime } from 'cron';

// The module inside the built package, from build/test where this runs.
const { isDue, parseCron } = (await import(new URL('../../dist/esm/schedule/cron.js', import.meta.url).href)) as typeof import('../dist/esm/schedule/cron.js');

const cronTimes = new Map<string, CronTime>();

/** Whether CronTime fires at `minute` (at its first second). */
function cronTimeDue(expression: string, minute: Date, timeZone: string): boolean {
  const key = `${expression}|${timeZone}`;
  let cronTime = cronTimes.get(key);
  if (cronTime === undefined) {
    cronTime = new CronTime(expression, timeZone);
    cronTimes.set(key, cronTime);
  }
  return cronTime.getNextDateFrom(new Date(minute.getTime() - 1000), timeZone).toMillis() === minute.getTime();
}

function minutes(from: string, count: number, step: number): Date[] {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, i) => new Date(start + i * step * 60_000));
}

const DAY = 24 * 60;

test('day-of-month and day-of-week restriction follows CronTime: a field is open when it covers every day', () => {
  const expressions = [
    '0 0 * * *',
    '0 0 */1 * 1', // every day of the month written as a step: open, so Mondays only
    '0 0 1-31 * 1',
    '0 0 1 * 0-6', // every weekday written as a range: open, so the 1st only
    '0 0 1 * 1-7',
    '0 0 1 * 0-7',
    '0 0 1 * */1',
    '0 0 1 * *',
    '0 0 * * 0',
    '0 0 * * 7',
    '0 0 */2 * 1', // both restricted: odd days or Mondays
    '0 0 1,15 * mon',
    '0 0 1-7 * 5',
    '0 0 13 * fri',
    '0 0 * * mon-fri',
    '0 0 */10 * sat,sun',
    '0 0 31 * *',
    '0 0 29 feb *',
    '0 0 1 */3 *',
    '0 0 5/7 * *',
  ];
  // Every midnight of 2028, a leap year.
  const days = minutes('2028-01-01T00:00:00Z', 366, DAY);

  for (const expression of expressions) {
    const cron = parseCron(expression);
    for (const day of days) {
      assert.equal(isDue(cron, day, { timeZone: 'UTC' }), cronTimeDue(expression, day, 'UTC'), `${expression} at ${day.toISOString()}`);
    }
  }
});

test('minutes, hours, steps and lists follow CronTime through a day', () => {
  const expressions = ['*/15 * * * *', '5/20 * * * *', '0 */3 * * *', '30 9-17 * * mon-fri', '0,30 8,20 * * *', '59 23 * * *', '@hourly', '@daily'];
  // Every 5 minutes of a Friday, and every minute of its last hour.
  const day = [...minutes('2026-03-06T00:00:00Z', DAY / 5, 5), ...minutes('2026-03-06T23:00:00Z', 60, 1)];
  for (const expression of expressions) {
    const cron = parseCron(expression);
    for (const minute of day) {
      assert.equal(isDue(cron, minute, { timeZone: 'UTC' }), cronTimeDue(expression, minute, 'UTC'), `${expression} at ${minute.toISOString()}`);
    }
  }
});

test('local time zones follow CronTime outside the daylight saving changes', () => {
  const zones = ['Europe/Paris', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];
  const expressions = ['0 9 * * *', '30 1 * * mon', '0 0 1 * *', '45 */2 * * *'];
  // Days with no clock change in any of these zones.
  const spans = [...minutes('2026-01-14T00:00:00Z', DAY / 15, 15), ...minutes('2026-07-14T00:00:00Z', DAY / 15, 15), ...minutes('2026-06-30T12:00:00Z', DAY / 15, 15)];
  for (const timeZone of zones) {
    for (const expression of expressions) {
      const cron = parseCron(expression);
      for (const minute of spans) {
        assert.equal(isDue(cron, minute, { timeZone }), cronTimeDue(expression, minute, timeZone), `${expression} in ${timeZone} at ${minute.toISOString()}`);
      }
    }
  }
});
