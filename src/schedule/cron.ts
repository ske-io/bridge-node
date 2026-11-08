/**
 * Cron expressions, and whether one is due in a given minute.
 *
 * Five fields (minute, hour, day of month, month, day of week) or six, with
 * seconds first, as Nest's `@Cron` takes them. Each field takes `*`, numbers,
 * ranges (`1-5`), steps (`*\/15`, `5/15`, `1-30/5`) and lists of these;
 * months and days take names (`jan`, `mon`), and Sunday is 0 or 7. The
 * shorthands `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`,
 * `@midnight`, `@hourly`, `@minutely`, `@secondly`, `@weekdays` and
 * `@weekends` are read too.
 *
 * When both day fields are restricted, a day matching either one is due, as
 * in classic cron. A day field is restricted when it leaves out some value:
 * `*`, `*\/1` and `1-31` are all open, as the cron package that
 * @nestjs/schedule runs decides it.
 *
 * Due-ness is decided from the minute alone, in the entry's time zone: the
 * minute's local fields must match. The seconds field does not take part;
 * an expression matching more than one second of a minute is "second-level"
 * and can only run once a minute here.
 */

export interface Cron {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
  /** Whether the expression matches more than one second of a minute. */
  readonly secondLevel: boolean;
}

export interface Zone {
  /** An IANA time zone; the process's own when neither this nor utcOffset is given. */
  readonly timeZone?: string | undefined;
  /** A fixed offset from UTC, in minutes. */
  readonly utcOffset?: number | undefined;
}

const SHORTHANDS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@minutely': '* * * * *',
  '@secondly': '* * * * * *',
  '@weekdays': '0 0 * * 1-5',
  '@weekends': '0 0 * * 0,6',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class InvalidCron extends Error {
  override name = 'InvalidCron';
}

export function parseCron(expression: string): Cron {
  const source = expression.trim();
  const expanded = SHORTHANDS[source.toLowerCase()] ?? source;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new InvalidCron(`${JSON.stringify(expression)} is not a cron expression: it needs 5 fields, or 6 with seconds first`);
  }
  const [second, minute, hour, day, month, weekday] = (fields.length === 6 ? fields : ['0', ...fields]) as [
    string, string, string, string, string, string,
  ];

  const weekdays = parseField(weekday, 0, 7, WEEKDAYS, expression);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }

  const days = parseField(day, 1, 31, undefined, expression);

  return {
    source,
    minutes: parseField(minute, 0, 59, undefined, expression),
    hours: parseField(hour, 0, 23, undefined, expression),
    days,
    months: parseField(month, 1, 12, MONTHS, expression, 1),
    weekdays,
    // As the cron package (which @nestjs/schedule runs) decides: a day field
    // is open when it covers every value, however it is written (`*`, `*\/1`,
    // `1-31`, `0-6`).
    daysRestricted: days.size < 31,
    weekdaysRestricted: weekdays.size < 7,
    secondLevel: parseField(second, 0, 59, undefined, expression).size > 1,
  };
}

/** Whether the cron is due in the minute that `at` falls in. */
export function isDue(cron: Cron, at: Date, zone: Zone = {}): boolean {
  const local = localFields(at, zone);
  if (!cron.minutes.has(local.minute) || !cron.hours.has(local.hour) || !cron.months.has(local.month)) {
    return false;
  }
  const dayMatches = cron.days.has(local.day);
  const weekdayMatches = cron.weekdays.has(local.weekday);
  if (cron.daysRestricted && cron.weekdaysRestricted) {
    return dayMatches || weekdayMatches;
  }
  return dayMatches && weekdayMatches;
}

/** Throws a RangeError unless the time zone is one this runtime knows. */
export function checkTimeZone(timeZone: string): void {
  formatter(timeZone);
}

interface LocalFields {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

function localFields(at: Date, zone: Zone): LocalFields {
  if (zone.utcOffset !== undefined) {
    const shifted = new Date(at.getTime() + zone.utcOffset * 60_000);
    return {
      minute: shifted.getUTCMinutes(),
      hour: shifted.getUTCHours(),
      day: shifted.getUTCDate(),
      month: shifted.getUTCMonth() + 1,
      weekday: shifted.getUTCDay(),
    };
  }

  const parts: Record<string, string> = {};
  for (const part of formatter(zone.timeZone).formatToParts(at)) {
    parts[part.type] = part.value;
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS.indexOf((parts.weekday ?? '').toLowerCase().slice(0, 3)),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let found = formatters.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', {
      ...(timeZone === undefined ? {} : { timeZone }),
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(key, found);
  }
  return found;
}

function parseField(field: string, low: number, high: number, names: string[] | undefined, expression: string, nameBase = 0): Set<number> {
  const values = new Set<number>();
  const fail = (why: string) => new InvalidCron(`${JSON.stringify(expression)} is not a cron expression: ${why}`);

  const value = (text: string): number => {
    const index = names?.indexOf(text.toLowerCase()) ?? -1;
    if (index !== -1) return index + nameBase;
    if (!/^\d+$/.test(text)) throw fail(`${JSON.stringify(text)} is not a number`);
    return Number(text);
  };

  for (const part of field.split(',')) {
    const match = /^(\*|\?|[^-/]+)(?:-([^/]+))?(?:\/(\d+))?$/.exec(part);
    if (match === null) throw fail(`${JSON.stringify(part)} cannot be read`);
    const [, start, end, step] = match;

    let from: number;
    let to: number;
    if (start === '*' || start === '?') {
      if (end !== undefined) throw fail(`${JSON.stringify(part)} cannot be read`);
      from = low;
      to = high;
    } else {
      from = value(start as string);
      to = end !== undefined ? value(end) : step !== undefined ? high : from;
    }

    const every = step === undefined ? 1 : Number(step);
    if (every === 0) throw fail(`${JSON.stringify(part)} has a step of zero`);
    if (from < low || to > high || from > to) throw fail(`${JSON.stringify(part)} is outside ${low}-${high}`);

    for (let n = from; n <= to; n += every) values.add(n);
  }
  return values;
}
