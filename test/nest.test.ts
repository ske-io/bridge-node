import 'reflect-metadata';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';

import { Controller, Get, HttpCode, Injectable, Module, Req, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Interval, ScheduleModule, Timeout, Cron } from '@nestjs/schedule';

import { dispatch } from '@ske-io/bridge';
import { Job, JobDispatcher, SkeModule, type SkeModuleOptions } from '@ske-io/bridge/nest';

import { conformance } from './conformance.ts';
import { BUILT_FIXTURES, batch, captureStderr, FIXTURES, INTERNAL, PLATFORM, record, records, runCli, useEnv, type Run } from './helpers.ts';

@Controller()
class AppController {
  @Get('whoami')
  whoami(@Req() req: { ip: string; protocol: string; hostname: string }) {
    return { ip: req.ip, protocol: req.protocol, hostname: req.hostname };
  }

  @Get('log')
  @HttpCode(204)
  async log(): Promise<void> {
    await sleep(1);
    console.log('handled');
  }
}

function appModule(options: SkeModuleOptions, extra: Function[] = []) {
  @Module({ imports: [SkeModule.forRoot(options)], controllers: [AppController], providers: extra as never[] })
  class AppModule {}
  return AppModule;
}

async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  after(() => app.close());
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

conformance('nest-express', async (options) => {
  const app = await NestFactory.create(appModule(options), { logger: false });
  // As main.ts would: middleware added after the app is created.
  app.use((req: { headers: Record<string, string> }, res: { statusCode: number; end(): void }, next: () => void) => {
    if (req.headers.authorization !== 'let-me-in') {
      res.statusCode = 401;
      res.end();
    } else next();
  });
  return listen(app);
});

conformance('nest-fastify', async (options) => {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(appModule(options), adapter, { logger: false });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'let-me-in') return reply.code(401).send();
  });
  return listen(app);
});

@Injectable()
class Mailer {
  sent: unknown[] = [];

  @Job('nest-welcome')
  async welcome(payload: { user: number }): Promise<void> {
    this.sent.push(payload);
  }
}

@Injectable()
class Signup {
  constructor(private readonly jobs: JobDispatcher) {}

  register(user: number): Promise<string> {
    return this.jobs.dispatch('nest-welcome', { user });
  }
}

test('nest: @Job methods handle jobs, dispatched through the injectable dispatcher', async () => {
  useEnv({ SKE_QUEUE_SYNC: '1' });
  const app = await NestFactory.createApplicationContext(appModule({}, [Mailer, Signup]), { logger: false });
  await app.get(Signup).register(7);
  await dispatch('nest-welcome', { user: 8 });
  assert.deepEqual(app.get(Mailer).sent, [{ user: 7 }, { user: 8 }]);
  await app.close();

  // Closing the app removes its jobs, so another app can define them again.
  await assert.rejects(dispatch('nest-welcome', { user: 9 }), /No job named/);
  const again = await NestFactory.createApplicationContext(appModule({}, [Mailer, Signup]), { logger: false });
  await again.close();
});

test('nest: delivered jobs run the @Job method on the platform', async () => {
  useEnv(PLATFORM);
  const app = await NestFactory.create(appModule({}, [Mailer]), { logger: false, abortOnError: false });
  const url = await listen(app);
  const response = await fetch(`${url}/__ske/queue`, { method: 'POST', headers: INTERNAL, body: batch([record('m1', 'nest-welcome', { user: 3 })]) });
  const reply = (await response.json()) as { outcomes: Array<{ deleted: boolean }> };
  assert.equal(reply.outcomes[0]?.deleted, true);
  assert.deepEqual(app.get(Mailer).sent, [{ user: 3 }]);
});

class Ticks {
  cron = 0;
  interval = 0;
  timeout = 0;

  @Cron('* * * * * *')
  everySecond(): void {
    this.cron++;
  }

  @Interval(20)
  poll(): void {
    this.interval++;
  }

  @Timeout('warm-up', 20)
  warmUp(): void {
    this.timeout++;
  }
}
Injectable()(Ticks);

function ticksModule() {
  @Module({ imports: [SkeModule.forRoot(), ScheduleModule.forRoot()], providers: [Ticks] })
  class TicksModule {}
  return TicksModule;
}

test('nest: on the platform no scheduler timer runs in the app, and intervals and timeouts are named in warnings', async () => {
  useEnv(PLATFORM);
  let ticks!: Ticks;
  const lines = await captureStderr(async () => {
    const app = await NestFactory.createApplicationContext(ticksModule(), { logger: false });
    ticks = app.get(Ticks);
    await sleep(1200);
    await app.close();
  });
  assert.deepEqual([ticks.cron, ticks.interval, ticks.timeout], [0, 0, 0]);
  const warnings = records(lines)
    .filter((log) => log.level_name === 'WARNING')
    .map((log) => String(log.message));
  // One line for all of them, naming each.
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0] as string, /Ticks\.poll \(@Interval\)/);
  assert.match(warnings[0] as string, /warm-up \(@Timeout\)/);
});

test('nest: off the platform the scheduler runs as usual', async () => {
  useEnv({});
  const app = await NestFactory.createApplicationContext(ticksModule(), { logger: false });
  const ticks = app.get(Ticks);
  await sleep(1200);
  await app.close();
  assert.ok(ticks.cron >= 1 && ticks.interval >= 1 && ticks.timeout === 1, JSON.stringify(ticks));
});

function lines(run: Run): string[] {
  return run.stdout.trim().split('\n').filter((line) => line !== '').sort();
}

const NEST_APP = join(BUILT_FIXTURES, 'nest-app');

test('nest: `ske-bridge schedule` runs the due @Cron methods, registry jobs and schedule() tasks, and exits', async () => {
  // 08:00 UTC on a January Monday is 09:00 in Paris, and the top of the hour.
  const run = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: '2026-01-12T08:00:00Z' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(lines(run), [
    'added-at-runtime ran',
    'bridge-task ran',
    'cleanup ran',
    'every-thirty-seconds ran',
    'flaky ran',
    'paris-report ran',
  ]);
  // One warning line per kind for the whole run, each naming its jobs.
  const warnings = run.logs.filter((log) => log.level_name === 'WARNING').map((log) => String(log.message));
  assert.equal(warnings.length, 2, warnings.join('\n'));
  const timers = warnings.find((message) => /@Interval/.test(message)) ?? '';
  assert.match(timers, /poller \(@Interval\)/);
  assert.match(timers, /Tasks\.warmUp \(@Timeout\)/);
  // Those added through the registry are in the same line.
  assert.match(timers, /metrics-poll \(interval\)/);
  assert.match(timers, /cache-refresh \(interval\)/);
  assert.match(timers, /warm-cache \(timeout\)/);
  const secondLevel = warnings.find((message) => /more than once a minute/.test(message)) ?? '';
  assert.match(secondLevel, /Tasks\.everyThirtySeconds/);
  assert.equal(run.logs.length, run.stderr.trim().split('\n').length, 'every line is a JSON record');
});

test('nest: a scheduler run boots quietly: none of Nest\'s start-up lines, its errors still logged', async () => {
  const run = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: '2026-01-12T08:01:00Z', FAIL_TASK: '1' });
  const fromNest = run.logs.filter((log) => log.channel !== 'bridge');
  assert.deepEqual(fromNest.map((log) => `${log.channel}: ${log.message}`), []);
  assert.ok(!run.stderr.includes('dependencies initialized'));
  assert.ok(run.logs.some((log) => log.level_name === 'ERROR' && log.message === 'Scheduled task flaky failed'));
  // The run's lines: the two warnings, one per task run, and the failure.
  assert.ok(run.logs.length <= 12, `${run.logs.length} lines:\n${run.stderr}`);
});

test('nest: decorated crons follow the registry: a new time, a deleted job, a replaced job', async () => {
  const at = async (time: string, env: Record<string, string> = {}) => {
    const run = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: time, ...env });
    assert.equal(run.code, 0, run.stderr);
    return lines(run);
  };
  // `moved` was set from 09:00 to 10:30 through the registry; `removed` was
  // deleted; `replaced` was swapped for a job of its own at quarter past.
  const nine = await at('2026-01-12T09:00:00Z');
  assert.ok(!nine.includes('moved ran'), nine.join());
  assert.ok(!nine.includes('removed ran') && !nine.includes('replaced original ran') && !nine.includes('replacement ran'), nine.join());

  const halfPast = await at('2026-01-12T10:30:00Z');
  assert.ok(halfPast.includes('moved ran'), halfPast.join());

  const quarterPast = await at('2026-01-12T10:15:00Z');
  assert.ok(quarterPast.includes('replacement ran') && !quarterPast.includes('replaced original ran'), quarterPast.join());

  // `moved` keeps its @EvenInMaintenance(); the replacement is a job of its own, without it.
  assert.deepEqual(await at('2026-01-12T10:30:00Z', { MAINTENANCE_MODE: 'true' }), ['cleanup ran', 'moved ran']);
  assert.deepEqual(await at('2026-01-12T10:15:00Z', { MAINTENANCE_MODE: 'true' }), ['cleanup ran']);
});

test('nest: unnamed @Cron methods follow their generated registry keys, and keep their Class.method names', async () => {
  const at = async (time: string, env: Record<string, string> = {}) => {
    const run = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: time, ...env });
    assert.equal(run.code, 0, run.stderr);
    return { lines: lines(run), ran: run.logs.map((log) => String(log.message)).filter((message) => message.startsWith('Ran ')) };
  };
  // Declared for 1 January at 00:00, 00:01 and 00:02 UTC; moved, deleted and
  // replaced through the registry by their generated keys.
  for (const minute of ['00', '01', '02']) {
    const run = await at(`2027-01-01T00:${minute}:00Z`);
    assert.ok(!run.lines.some((line) => line.startsWith('unnamed')), `${minute}: ${run.lines.join()}`);
  }
  const moved = await at('2026-01-12T10:45:00Z');
  assert.ok(moved.lines.includes('unnamed moved ran'), moved.lines.join());
  assert.ok(moved.ran.some((message) => message.startsWith('Ran Tasks.unnamedMoved in')), moved.ran.join());

  const replaced = await at('2026-01-12T10:50:00Z');
  assert.ok(replaced.lines.includes('unnamed replacement ran') && !replaced.lines.includes('unnamed replaced original ran'), replaced.lines.join());
  assert.ok(replaced.ran.some((message) => message.startsWith('Ran Tasks.unnamedReplaced in')), replaced.ran.join());

  // The moved method keeps its @EvenInMaintenance().
  assert.ok((await at('2026-01-12T10:45:00Z', { MAINTENANCE_MODE: 'true' })).lines.includes('unnamed moved ran'));
});

test('nest: a due cron is decided in its own time zone', async () => {
  const run = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: '2026-01-12T09:00:00Z' });
  assert.ok(!lines(run).includes('paris-report ran'));
});

test('nest: a failing @Cron fails the run; maintenance runs only marked crons', async () => {
  const failing = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: '2026-01-12T08:01:00Z', FAIL_TASK: '1' });
  assert.equal(failing.code, 1);
  assert.ok(failing.logs.some((log) => log.message === 'Scheduled task flaky failed' && log.context.exception.message === 'flaky broke'));
  assert.ok(lines(failing).includes('cleanup ran'));

  const paused = await runCli(['schedule', 'app.module.js'], NEST_APP, { SKE_SCHEDULED_AT: '2026-01-12T08:01:00Z', MAINTENANCE_MODE: 'true' });
  assert.equal(paused.code, 0);
  assert.deepEqual(lines(paused), ['cleanup ran']);
});

test('nest: the default entry is dist/app.module.js of a NestJS app, and a CommonJS app works', async () => {
  const app = join(BUILT_FIXTURES, 'nest-default');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@nestjs/core': '*' } }));
  const cjs = pathToFileURL(join(FIXTURES, 'nest-cjs', 'app.module.cjs')).href;
  writeFileSync(join(app, 'dist', 'app.module.js'), `export { AppModule } from '${cjs}';\n`);
  const run = await runCli(['schedule'], app, { SKE_SCHEDULED_AT: '2026-01-12T08:01:00Z' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(lines(run), ['commonjs-cron ran']);
});

test('nest: a short-lived context that just exits still writes its skipped-timer warning', async () => {
  const child = spawn(process.execPath, [join(FIXTURES, 'nest-short', 'app.mjs')], { env: { ...process.env, ...PLATFORM } });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  assert.equal(code, 0, stderr);
  const warnings = records(stderr.split('\n')).filter((log) => log.level_name === 'WARNING');
  assert.equal(warnings.length, 1, stderr);
  assert.match(String(warnings[0]?.message), /short-poll \(@Interval\).*short-warm-up \(@Timeout\)/);
});
