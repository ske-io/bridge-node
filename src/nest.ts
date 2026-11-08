/**
 * The NestJS integration:
 *
 *     @Module({ imports: [SkeModule.forRoot(), ScheduleModule.forRoot(), ...] })
 *     export class AppModule {}
 *
 * On the platform, with Nest's Express or Fastify adapter, SkeModule installs
 * the bridge on the HTTP server as Nest creates the application, before
 * anything `main.ts` adds: the internal routes and maintenance mode are
 * answered first, and the client's address, scheme and host come from the
 * one hop the platform puts in front of the app. Nest's logger writes the
 * platform's JSON records.
 *
 * Jobs: a provider method marked `@Job('name')` is the handler of that job,
 * and `JobDispatcher` dispatches jobs from anywhere in the app.
 *
 * Schedule: `ske-bridge schedule` runs the `@Cron` methods (and jobs added to
 * Nest's `SchedulerRegistry`) due this minute. On the platform no timer of
 * Nest's scheduler runs in the application: cron jobs are stopped as Nest
 * starts them, and `@Interval` and `@Timeout` methods, which only a
 * long-running process could keep, are skipped with a warning naming them.
 * Off the platform, `nest start` runs them as usual.
 */

import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  SetMetadata,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, HttpAdapterHost, MetadataScanner, ModuleRef, Reflector } from '@nestjs/core';

import { onPlatform } from './env.js';
import { bridge as expressBridge, type ExpressApp } from './express.js';
import { bridge as fastifyBridge, type FastifyInstanceLike } from './fastify.js';
import { bridgeLog, structuredLogs } from './logging.js';
import { SkeLogger, type SkeLoggerOptions } from './nest-logger.js';
import { defineJob, dispatch, undefineJob, type DispatchOptions, type JobHandler } from './queue/jobs.js';
import { activate, type BridgeOptions } from './request.js';
import { state, type ScheduledTask } from './state.js';

export type { BridgeOptions, DispatchOptions };
export { SkeLogger };

export interface SkeModuleOptions extends BridgeOptions {}

export const SKE_OPTIONS = Symbol.for('@ske-io/bridge:options');

/**
 * SkeExplorer under a token both builds of the package share, for
 * `ske-bridge schedule`, which may load the other build than the app.
 */
export const SKE_SCHEDULE = Symbol.for('@ske-io/bridge:schedule');

const JOB = 'ske:job';
const EVEN_IN_MAINTENANCE = 'ske:even-in-maintenance';

// @nestjs/schedule's metadata, which its @Cron, @Interval and @Timeout set.
const SCHEDULER_TYPE = 'SCHEDULER_TYPE';
const SCHEDULER_NAME = 'SCHEDULER_NAME';
const CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const CRON = 1;
const TIMEOUT = 2;
const INTERVAL = 3;

/** How long after the last skipped timer the warning naming them is written. */
const SKIPPED_FLUSH_MS = 100;

/** The names @nestjs/schedule gives jobs declared without one. */
const GENERATED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marks a provider method as the handler of the job `name`. */
export function Job(name: string): MethodDecorator {
  return SetMetadata(JOB, name);
}

/** Marks a `@Cron` method to run while the app is in maintenance mode, too. */
export function EvenInMaintenance(): MethodDecorator {
  return SetMetadata(EVEN_IN_MAINTENANCE, true);
}

/** Dispatches jobs; see dispatch(). */
export class JobDispatcher {
  dispatch(name: string, payload: unknown, options?: DispatchOptions): Promise<string> {
    return dispatch(name, payload, options);
  }
}
Injectable()(JobDispatcher);

/** A Nest cron job from @nestjs/schedule's registry, as far as it is read here. */
interface RegistryCronJob {
  cronTime: { source: unknown; timeZone?: string; utcOffset?: number };
  stop(): unknown;
  start(): unknown;
  fireOnTick(): Promise<void>;
  waitForCompletion: boolean;
  errorHandler?: ((error: unknown) => void) | undefined;
}

interface Registry {
  getCronJobs(): Map<string, RegistryCronJob>;
  getIntervals(): string[];
  getTimeouts(): string[];
  getInterval(name: string): NodeJS.Timeout;
  getTimeout(name: string): NodeJS.Timeout;
  addCronJob(name: string, job: RegistryCronJob): void;
  addInterval(name: string, id: NodeJS.Timeout): void;
  addTimeout(name: string, id: NodeJS.Timeout): void;
}

/**
 * Finds the app's `@Job` and `@Cron` methods, and keeps Nest's scheduler from
 * running timers where the platform's scheduler runs them instead.
 */
export class SkeExplorer implements OnModuleInit, OnApplicationShutdown {
  private readonly defined: [string, JobHandler<any>][] = [];
  /** Every `@Cron` method, the disabled ones too, in the order @nestjs/schedule finds them. */
  private readonly crons: DecoratedCron[] = [];
  /** The names of every `@Cron` method, the disabled ones too. */
  private readonly cronNames = new Set<string>();
  /** The names of the `@Interval` and `@Timeout` methods that have one. */
  private readonly timerNames = new Set<string>();
  /**
   * The registry key and job @nestjs/schedule registered for each `@Cron`
   * method: its name, or a generated key for an unnamed one. The app may
   * change the job through the registry later (`setTime`), delete it, or put
   * a job of its own under the key; scheduledTasks() follows that.
   */
  private readonly mounted = new Map<DecoratedCron, { key: string; job: RegistryCronJob }>();
  private registry: Registry | undefined;
  /** Timers skipped since the last warning about them; see skipTimer(). */
  private readonly skippedTimers: string[] = [];
  private skippedFlush: NodeJS.Timeout | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    const stopTimers = onPlatform() || state().schedulerRun;
    const skipped: string[] = [];

    // Controllers first, as @nestjs/schedule explores them: unnamed cron
    // methods are matched to their registry keys in this order.
    for (const wrapper of [...this.discovery.getControllers(), ...this.discovery.getProviders()]) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      const prototype = instance ? Object.getPrototypeOf(instance) : null;
      // A request-scoped provider has no instance to run a job or task on,
      // as @nestjs/schedule finds too.
      if (!instance || !prototype || !wrapper.isDependencyTreeStatic()) continue;

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = instance[method];
        if (typeof fn !== 'function') continue;
        const label = `${prototype.constructor?.name ?? 'Provider'}.${method}`;

        const job = this.reflector.get<string | undefined>(JOB, fn);
        if (job !== undefined) {
          const handler: JobHandler<any> = (payload, context) => fn.call(instance, payload, context);
          defineJob(job, handler);
          this.defined.push([job, handler]);
        }

        const type = this.reflector.get<number | undefined>(SCHEDULER_TYPE, fn);
        if (type === CRON) {
          this.addCron(instance, fn, label);
        } else if (type === INTERVAL || type === TIMEOUT) {
          const name = this.reflector.get<string | undefined>(SCHEDULER_NAME, fn);
          if (name !== undefined) this.timerNames.add(name);
          if (stopTimers) skipped.push(`${name ?? label} (@${type === INTERVAL ? 'Interval' : 'Timeout'})`);
        }
      }
    }

    for (const timer of skipped) this.skipTimer(timer);

    this.registry = await this.findRegistry();
    if (this.registry !== undefined) {
      this.recordMounted(this.registry);
      if (stopTimers) this.stopTimers(this.registry);
    }
  }

  onApplicationShutdown(): void {
    this.flushSkippedTimers();
    for (const [name, handler] of this.defined) undefineJob(name, handler);
    this.defined.length = 0;
  }

  /**
   * The `@Cron` methods, as the registry has them now, then the other cron
   * jobs in the registry.
   *
   * A `@Cron` method runs on its provider, with its maintenance marker, under
   * its name or `Class.method`. Its expression and time zone are its registry
   * job's, so a `setTime()` moves it; a job deleted from the registry does not
   * run, and one replaced by another job under its key runs as that job, its
   * own callback and no maintenance marker. A method @nestjs/schedule never
   * registered (its `cronJobs` option off) runs as declared.
   */
  scheduledTasks(): ScheduledTask[] {
    this.flushSkippedTimers();
    const registered = this.registry?.getCronJobs() ?? new Map<string, RegistryCronJob>();
    const tasks: ScheduledTask[] = [];
    const keys = new Map<string, DecoratedCron>();
    const fixedDates: string[] = [];

    for (const cron of this.crons) {
      const mounted = this.mounted.get(cron);
      if (mounted !== undefined) keys.set(mounted.key, cron);
      if (cron.disabled) continue;
      if (mounted === undefined) {
        if (typeof cron.cron !== 'string') {
          fixedDates.push(cron.name);
          continue;
        }
        tasks.push({ ...cron.timing, cron: cron.cron, name: cron.name, evenInMaintenance: cron.evenInMaintenance, run: cron.run });
        continue;
      }
      if (registered.get(mounted.key) !== mounted.job) continue;
      const timing = registryTiming(cron.name, mounted.job, fixedDates);
      if (timing !== undefined) tasks.push({ name: cron.name, evenInMaintenance: cron.evenInMaintenance, run: cron.run, ...timing });
    }

    for (const [key, job] of registered) {
      const cron = keys.get(key);
      if (cron !== undefined && this.mounted.get(cron)?.job === job) continue;
      if (cron === undefined && this.cronNames.has(key)) continue;
      const name = cron?.name ?? key;
      const timing = registryTiming(name, job, fixedDates);
      if (timing === undefined) continue;
      tasks.push({ name, ...timing, evenInMaintenance: false, run: () => runCronJob(job) });
    }
    if (fixedDates.length > 0) {
      bridgeLog.warning(`Skipped ${fixedDates.length} cron job(s) set for a fixed date, which the schedule does not support: ${fixedDates.join(', ')}`, {
        jobs: fixedDates,
      });
    }
    return tasks;
  }

  /**
   * Remembers the key and job @nestjs/schedule registers for each `@Cron`
   * method: a named one by its name; an unnamed one, registered under a
   * generated key, as the first method not yet matched with the same
   * expression and time zone, since @nestjs/schedule registers them in the
   * order this explorer finds them.
   */
  private recordMounted(registry: Registry): void {
    const mounted = new Set<string>();
    const record = (key: string, job: RegistryCronJob) => {
      if (mounted.has(key)) return;
      const cron = this.cronNames.has(key)
        ? this.crons.find((candidate) => candidate.key === key && !this.mounted.has(candidate))
        : GENERATED_NAME.test(key)
          ? this.crons.find((candidate) => candidate.key === undefined && !this.mounted.has(candidate) && sameTiming(candidate, job))
          : undefined;
      if (cron === undefined) return;
      this.mounted.set(cron, { key, job });
      mounted.add(key);
    };
    for (const [key, job] of registry.getCronJobs()) record(key, job);
    const { addCronJob } = registry;
    registry.addCronJob = function (key, job) {
      addCronJob.call(this, key, job);
      record(key, job);
    };
  }

  private addCron(instance: object, fn: Function, label: string): void {
    const options = this.reflector.get<Record<string, unknown> | undefined>(CRON_OPTIONS, fn) ?? {};
    const named = typeof options.name === 'string' && options.name !== '';
    const name = named ? (options.name as string) : label;
    this.cronNames.add(name);
    this.crons.push({
      name,
      key: named ? name : undefined,
      cron: options.cronTime,
      timing: {
        ...(typeof options.timeZone === 'string' ? { timeZone: options.timeZone } : {}),
        ...(typeof options.utcOffset === 'number' ? { utcOffset: options.utcOffset } : {}),
      },
      disabled: options.disabled === true,
      evenInMaintenance: this.reflector.get<boolean | undefined>(EVEN_IN_MAINTENANCE, fn) === true,
      run: () => fn.call(instance),
    });
  }

  private async findRegistry(): Promise<Registry | undefined> {
    let schedule: { SchedulerRegistry: new (...args: never[]) => unknown };
    try {
      schedule = await import('@nestjs/schedule');
    } catch {
      return undefined;
    }
    try {
      return this.moduleRef.get(schedule.SchedulerRegistry, { strict: false }) as Registry;
    } catch {
      return undefined;
    }
  }

  /**
   * Notes a timer the platform can't run. They are logged together, in one
   * warning naming them all: when the scheduler asks for its tasks, or once
   * the app has stopped adding them (a moment after the last one), so a
   * start-up, or a scheduler run, writes one line however many there are.
   */
  private skipTimer(timer: string): void {
    this.skippedTimers.push(timer);
    clearTimeout(this.skippedFlush);
    this.skippedFlush = setTimeout(this.flushOnExit, SKIPPED_FLUSH_MS);
    this.skippedFlush.unref();
    // The timer is unref'd, so a process that ends sooner still writes the
    // warning as its event loop empties; the listener adds no work to it.
    process.removeListener('beforeExit', this.flushOnExit);
    process.once('beforeExit', this.flushOnExit);
  }

  private readonly flushOnExit = (): void => this.flushSkippedTimers();

  private flushSkippedTimers(): void {
    clearTimeout(this.skippedFlush);
    this.skippedFlush = undefined;
    process.removeListener('beforeExit', this.flushOnExit);
    if (this.skippedTimers.length === 0) return;
    const jobs = this.skippedTimers.splice(0);
    bridgeLog.warning(
      `Skipped ${jobs.length} timer(s), since the platform runs no timers in the app; use @Cron, which the platform's scheduler runs: ${jobs.join(', ')}`,
      { jobs },
    );
  }

  /**
   * Stops what Nest's scheduler starts: the registry's jobs now, and any
   * added later as soon as they are added. @nestjs/schedule starts its jobs
   * after every module's onModuleInit, so this sees them all.
   */
  private stopTimers(registry: Registry): void {
    // A timer @nestjs/schedule mounts for a decorated method is named
    // already, as `Class.method` or its own name; the others were added in
    // code.
    const warn = (name: string, kind: string) => {
      if (!GENERATED_NAME.test(name) && !this.timerNames.has(name)) this.skipTimer(`${name} (${kind})`);
    };

    const stopCron = (job: RegistryCronJob) => {
      job.stop();
      job.start = () => undefined;
    };
    for (const job of registry.getCronJobs().values()) stopCron(job);
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name));
      warn(name, 'interval');
    }
    for (const name of registry.getTimeouts()) {
      clearTimeout(registry.getTimeout(name));
      warn(name, 'timeout');
    }

    const { addCronJob, addInterval, addTimeout } = registry;
    registry.addCronJob = function (name, job) {
      addCronJob.call(this, name, job);
      stopCron(job);
    };
    registry.addInterval = function (name, id) {
      addInterval.call(this, name, id);
      clearInterval(id);
      warn(name, 'interval');
    };
    registry.addTimeout = function (name, id) {
      addTimeout.call(this, name, id);
      clearTimeout(id);
      warn(name, 'timeout');
    };
  }
}
Injectable()(SkeExplorer);
Inject(DiscoveryService)(SkeExplorer, undefined, 0);
Inject(MetadataScanner)(SkeExplorer, undefined, 1);
Inject(Reflector)(SkeExplorer, undefined, 2);
Inject(ModuleRef)(SkeExplorer, undefined, 3);

/** A `@Cron` method, as declared. */
interface DecoratedCron {
  /** Its `name` option, else `Class.method`. */
  readonly name: string;
  /** Its registry key when it is named; unnamed ones get generated keys. */
  readonly key: string | undefined;
  readonly cron: unknown;
  readonly timing: { readonly timeZone?: string; readonly utcOffset?: number };
  readonly disabled: boolean;
  readonly evenInMaintenance: boolean;
  readonly run: () => unknown;
}

/** Whether a registry job is set up as an unnamed `@Cron` method declares. */
function sameTiming(cron: DecoratedCron, job: RegistryCronJob): boolean {
  const { source, timeZone, utcOffset } = job.cronTime;
  if (source !== cron.cron) return false;
  if (cron.timing.utcOffset !== undefined) return utcOffset === cron.timing.utcOffset;
  if (utcOffset !== undefined && utcOffset !== null) return false;
  return cron.timing.timeZone === undefined || timeZone === cron.timing.timeZone;
}

/**
 * A registry job's expression and time zone, or undefined for one at a fixed
 * date, whose name is added to `fixedDates`.
 */
function registryTiming(name: string, job: RegistryCronJob, fixedDates: string[]): { cron: string; timeZone?: string; utcOffset?: number } | undefined {
  const { source, timeZone, utcOffset } = job.cronTime;
  if (typeof source !== 'string') {
    fixedDates.push(name);
    return undefined;
  }
  return utcOffset !== undefined && utcOffset !== null ? { cron: source, utcOffset } : { cron: source, ...(timeZone ? { timeZone } : {}) };
}

/** Runs a registry cron job's callbacks, waiting for them and seeing their errors. */
async function runCronJob(job: RegistryCronJob): Promise<void> {
  const { waitForCompletion, errorHandler } = job;
  let failure: { error: unknown } | undefined;
  job.waitForCompletion = true;
  job.errorHandler = (error) => {
    failure ??= { error };
  };
  try {
    await job.fireOnTick();
  } finally {
    job.waitForCompletion = waitForCompletion;
    job.errorHandler = errorHandler;
  }
  if (failure !== undefined) throw failure.error;
}

/** Nest's logger state, which `NestFactory.create(…, { logger })` sets. */
const nestLogger = Logger as unknown as { staticInstanceRef?: unknown; logLevels?: unknown };

/**
 * Whether Nest's logger is its own default: no logger set with
 * `Logger.overrideLogger()` or NestFactory's `logger` option, whenever that
 * happened. Nest's `Logger` answers it: with no override in place, each
 * `Logger` writes through a console logger of its own, and with one, through
 * the override itself.
 */
function nestLoggerIsDefault(): boolean {
  const current = nestLogger.staticInstanceRef;
  if (current === undefined) return false;
  const probe = new Logger() as unknown as { localInstance: unknown };
  return probe.localInstance !== current;
}

/**
 * The logger to make Nest's on the platform, or undefined to keep the app's
 * choice. With no `logger` option given to NestFactory, or one this module
 * set for an earlier app, SkeLogger; with only log levels (`logger:
 * ['error', 'warn']`), SkeLogger with those levels, since levels choose what
 * is written, not its format. `logger: false` and a logger of the app's own,
 * a SkeLogger it configured included, are kept as they are.
 */
function platformNestLogger(): SkeLogger | undefined {
  const current = nestLogger.staticInstanceRef;
  if (!nestLoggerIsDefault() && (current === undefined || current !== state().nestLogger)) {
    return undefined;
  }
  const levels = nestLogger.logLevels;
  return Array.isArray(levels) ? new SkeLogger({ levels: levels as NonNullable<SkeLoggerOptions['levels']> }) : new SkeLogger();
}

export class SkeModule {
  constructor(host: HttpAdapterHost, options: SkeModuleOptions) {
    if (!activate()) return;

    // `ske-bridge schedule` sets Nest's logger itself, a quiet one; an app
    // that chose its own logger, or none, keeps its choice.
    if (structuredLogs() && !state().schedulerRun) {
      const logger = platformNestLogger();
      if (logger !== undefined) {
        Logger.overrideLogger(logger);
        state().nestLogger = logger;
      }
    }

    const adapter = host.httpAdapter;
    if (adapter == null) return;
    const type = adapter.getType();
    if (type === 'express') {
      expressBridge(adapter.getInstance<ExpressApp>(), options);
    } else if (type === 'fastify') {
      void fastifyBridge(adapter.getInstance<FastifyInstanceLike>(), options);
    } else {
      bridgeLog.warning(`The bridge does not support Nest's ${type} adapter; the internal routes are not installed`);
    }
  }

  static forRoot(options: SkeModuleOptions = {}): DynamicModule {
    return { module: SkeModule, providers: [{ provide: SKE_OPTIONS, useValue: options }] };
  }
}
Inject(HttpAdapterHost)(SkeModule, undefined, 0);
Inject(SKE_OPTIONS)(SkeModule, undefined, 1);
Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: SKE_OPTIONS, useValue: {} },
    JobDispatcher,
    SkeExplorer,
    { provide: SKE_SCHEDULE, useExisting: SkeExplorer },
  ],
  exports: [JobDispatcher, SkeExplorer, SKE_SCHEDULE],
})(SkeModule);
Global()(SkeModule);
