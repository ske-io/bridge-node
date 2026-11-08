/**
 * One run of the schedule: the tasks due in one minute, run one after the
 * other in this process, each awaited.
 *
 * The minute is the one the platform scheduled the run for, which it passes
 * as `SKE_SCHEDULED_AT` (an RFC 3339 time), so a run that starts late or is
 * retried runs that minute's tasks; without it the clock decides. Nothing is
 * remembered between runs, so due-ness is decided from the minute alone (see
 * cron). A tick the platform delivers twice runs its tasks twice: a task that
 * must never run twice guards itself.
 *
 * While the app is in maintenance mode, a task runs only when it is marked
 * to run anyway.
 */

import { env } from '../env.js';
import { bridgeLog, exceptionRecord } from '../logging.js';
import { maintenanceActive } from '../maintenance.js';
import type { ScheduledTask } from '../state.js';
import { isDue, parseCron } from './cron.js';

export interface TickResult {
  readonly ran: string[];
  readonly skipped: string[];
  readonly failed: string[];
}

/** The minute this run is for, at its first millisecond. */
export function scheduledMinute(): Date {
  const value = env('SKE_SCHEDULED_AT');
  let at = new Date();
  if (value !== undefined) {
    const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
    const parsed = Date.parse(value.trim());
    if (rfc3339.test(value.trim()) && !Number.isNaN(parsed)) {
      at = new Date(parsed);
    } else {
      bridgeLog.warning(`SKE_SCHEDULED_AT ${JSON.stringify(value)} is not an RFC 3339 time with an offset; using the clock`);
    }
  }
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/** Runs the tasks due in `minute`. A failing task does not stop the others. */
export async function tick(tasks: ScheduledTask[], minute: Date): Promise<TickResult> {
  const paused = maintenanceActive();
  const result: TickResult = { ran: [], skipped: [], failed: [] };
  const secondLevelTasks: string[] = [];

  for (const task of tasks) {
    let due: boolean;
    let secondLevel: boolean;
    try {
      const cron = parseCron(task.cron);
      due = isDue(cron, minute, { timeZone: task.timeZone, utcOffset: task.utcOffset });
      secondLevel = cron.secondLevel;
    } catch (error) {
      result.failed.push(task.name);
      bridgeLog.error(`Scheduled task ${task.name} has an expression that cannot be read`, { exception: exceptionRecord(error) });
      continue;
    }
    if (!due) continue;

    if (paused && !task.evenInMaintenance) {
      result.skipped.push(task.name);
      bridgeLog.info(`Skipped ${task.name}: maintenance mode is on`);
      continue;
    }
    if (secondLevel) secondLevelTasks.push(`${task.name} (${task.cron})`);

    const started = Date.now();
    try {
      await task.run();
      result.ran.push(task.name);
      bridgeLog.info(`Ran ${task.name} in ${Date.now() - started}ms`);
    } catch (error) {
      result.failed.push(task.name);
      bridgeLog.error(`Scheduled task ${task.name} failed`, { exception: exceptionRecord(error) });
    }
  }

  // One line for the run, however many tasks: the same warning every minute
  // for each would drown the log.
  if (secondLevelTasks.length > 0) {
    bridgeLog.warning(
      `${secondLevelTasks.length} scheduled task(s) run more than once a minute, but the schedule runs once a minute; each ran once this minute: ${secondLevelTasks.join(', ')}`,
      { tasks: secondLevelTasks },
    );
  }
  if (result.ran.length === 0 && result.failed.length === 0 && result.skipped.length === 0) {
    bridgeLog.debug('Nothing is due');
  }
  return result;
}
