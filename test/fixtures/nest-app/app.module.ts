// A NestJS app's root module, as `nest build` would emit it to
// dist/app.module.js; `ske-bridge schedule` boots it without an HTTP server.
import 'reflect-metadata';

import { Injectable, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval, ScheduleModule, SchedulerRegistry, Timeout } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';

import { schedule } from '@ske-io/bridge';
import { EvenInMaintenance, SkeModule } from '@ske-io/bridge/nest';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

@Injectable()
export class Tasks implements OnModuleInit, OnApplicationBootstrap {
  constructor(private readonly registry: SchedulerRegistry) {}

  onModuleInit(): void {
    this.registry.addCronJob('added-at-runtime', CronJob.from({ cronTime: '0 * * * *', onTick: () => say('added-at-runtime ran') }));
  }

  /** Changes the decorated jobs through the registry, once Nest has started them. */
  onApplicationBootstrap(): void {
    // Timers added in code, which the platform cannot keep either.
    this.registry.addInterval('metrics-poll', setInterval(() => say('metrics-poll ran'), 10));
    this.registry.addInterval('cache-refresh', setInterval(() => say('cache-refresh ran'), 10));
    this.registry.addTimeout('warm-cache', setTimeout(() => say('warm-cache ran'), 10));

    this.registry.getCronJob('moved').setTime(new CronTime('30 10 * * *', 'UTC'));
    this.registry.deleteCronJob('removed');
    this.registry.deleteCronJob('replaced');
    this.registry.addCronJob('replaced', CronJob.from({ cronTime: '15 * * * *', timeZone: 'UTC', onTick: () => say('replacement ran') }));

    // The unnamed methods are registered under generated keys; an app finds
    // them by their expression.
    const keyOf = (expression: string) => [...this.registry.getCronJobs()].find(([, job]) => job.cronTime.source === expression)?.[0] as string;
    this.registry.getCronJob(keyOf('0 0 1 1 *')).setTime(new CronTime('45 10 * * *', 'UTC'));
    this.registry.deleteCronJob(keyOf('1 0 1 1 *'));
    const replaced = keyOf('2 0 1 1 *');
    this.registry.deleteCronJob(replaced);
    this.registry.addCronJob(replaced, CronJob.from({ cronTime: '50 * * * *', timeZone: 'UTC', onTick: () => say('unnamed replacement ran') }));
  }

  @Cron('0 0 1 1 *', { timeZone: 'UTC' })
  @EvenInMaintenance()
  unnamedMoved(): void {
    say('unnamed moved ran');
  }

  @Cron('1 0 1 1 *', { timeZone: 'UTC' })
  unnamedRemoved(): void {
    say('unnamed removed ran');
  }

  @Cron('2 0 1 1 *', { timeZone: 'UTC' })
  unnamedReplaced(): void {
    say('unnamed replaced original ran');
  }

  @Cron('0 9 * * *', { name: 'moved', timeZone: 'UTC' })
  @EvenInMaintenance()
  moved(): void {
    say('moved ran');
  }

  @Cron('* * * * *', { name: 'removed' })
  removed(): void {
    say('removed ran');
  }

  @Cron('* * * * *', { name: 'replaced' })
  @EvenInMaintenance()
  replaced(): void {
    say('replaced original ran');
  }

  @Cron('0 9 * * *', { name: 'paris-report', timeZone: 'Europe/Paris' })
  async report(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    say('paris-report ran');
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  everyThirtySeconds(): void {
    say('every-thirty-seconds ran');
  }

  @Cron('* * * * *', { name: 'cleanup' })
  @EvenInMaintenance()
  cleanup(): void {
    say('cleanup ran');
  }

  @Cron('* * * * *', { name: 'flaky' })
  flaky(): void {
    if (process.env.FAIL_TASK === '1') throw new Error('flaky broke');
    say('flaky ran');
  }

  @Cron('* * * * *', { name: 'switched-off', disabled: true })
  switchedOff(): void {
    say('switched-off ran');
  }

  @Interval('poller', 10)
  poll(): void {
    say('poller ran');
  }

  @Timeout(10)
  warmUp(): void {
    say('warm-up ran');
  }
}

schedule('bridge-task', '* * * * *', () => say('bridge-task ran'));

@Module({ imports: [SkeModule.forRoot(), ScheduleModule.forRoot()], providers: [Tasks] })
export class AppModule {}
