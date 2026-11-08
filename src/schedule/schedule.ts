/**
 * Scheduled tasks, run by the platform's scheduler:
 *
 *     schedule('prune-sessions', '0 3 * * *', async () => { ... }, { timeZone: 'Europe/Paris' });
 *
 * No timer runs in the application. Once a minute the platform runs
 * `ske-bridge schedule`, which loads the app, runs the tasks due that minute,
 * waits for them and exits (see tick).
 */

import { state, type ScheduledTask } from '../state.js';
import { checkTimeZone, parseCron } from './cron.js';

export interface ScheduleOptions {
  /** The IANA time zone the expression is read in; the process's own by default. */
  timeZone?: string;
  /** Run this task while the app is in maintenance mode, too. */
  evenInMaintenance?: boolean;
}

/**
 * Adds a task to the schedule. Throws when the name is taken, the expression
 * cannot be read or the time zone is unknown, so a mistake shows when the
 * app loads rather than when the task should have run.
 */
export function schedule(name: string, cron: string, handler: () => unknown, options: ScheduleOptions = {}): void {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('A scheduled task needs a name');
  }
  if (typeof handler !== 'function') {
    throw new TypeError(`Scheduled task ${JSON.stringify(name)} needs a handler function`);
  }
  parseCron(cron);
  if (options.timeZone !== undefined) {
    checkTimeZone(options.timeZone);
  }

  const tasks = state().schedule;
  if (tasks.has(name)) {
    throw new Error(`A scheduled task named ${JSON.stringify(name)} is already defined`);
  }
  tasks.set(name, {
    name,
    cron,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    evenInMaintenance: options.evenInMaintenance === true,
    run: handler,
  });
}

/** The tasks schedule() added, in the order they were added. */
export function scheduledTasks(): ScheduledTask[] {
  return [...state().schedule.values()];
}

export type { ScheduledTask };
