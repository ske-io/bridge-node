/**
 * Which logger Nest uses on the platform: the bridge's JSON one when the app
 * left Nest's default, and the app's own choice otherwise. Nest keeps its
 * logger process-wide, so each test puts the default back.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { Logger, Module, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { SkeLogger, SkeModule } from '@ske-io/bridge/nest';

import { captureStderr, FIXTURES, PLATFORM, records, useEnv } from './helpers.ts';

const nest = Logger as unknown as { staticInstanceRef: unknown; logLevels: unknown };
const DEFAULT = nest.staticInstanceRef;

afterEach(() => {
  nest.staticInstanceRef = DEFAULT;
  nest.logLevels = undefined;
});

function appModule() {
  @Module({ imports: [SkeModule.forRoot()] })
  class AppModule {}
  return AppModule;
}

/** The JSON records Nest itself wrote (its contexts are the channels). */
async function nestRecords(options: object): Promise<Array<Record<string, any>>> {
  const lines = await captureStderr(async () => {
    const app = await NestFactory.createApplicationContext(appModule(), options);
    const orders = new Logger('Orders');
    orders.log('order placed');
    orders.warn('stock low');
    orders.error('payment failed');
    await app.close();
  });
  return records(lines).filter((log) => log.channel !== 'bridge');
}

test("with Nest's default logger, Nest writes the platform's JSON records", async () => {
  useEnv(PLATFORM);
  const logs = await nestRecords({});
  assert.ok(logs.some((log) => log.channel === 'Orders' && log.message === 'order placed' && log.level_name === 'INFO'), JSON.stringify(logs));
});

test('logger: false is respected: Nest writes nothing', async () => {
  useEnv(PLATFORM);
  assert.deepEqual(await nestRecords({ logger: false }), []);
});

test("the app's own logger is respected", async () => {
  useEnv(PLATFORM);
  const seen: string[] = [];
  const own: LoggerService = {
    log: (message) => seen.push(String(message)),
    error: () => undefined,
    warn: () => undefined,
  };
  assert.deepEqual(await nestRecords({ logger: own }), []);
  assert.ok(seen.includes('order placed'), seen.join('\n'));
});

test("the app's log levels are respected, in the platform's JSON records", async () => {
  useEnv(PLATFORM);
  const logs = await nestRecords({ logger: ['error', 'warn'] });
  const orders = logs.filter((log) => log.channel === 'Orders').map((log) => [log.level_name, log.message]);
  assert.deepEqual(orders, [
    ['WARNING', 'stock low'],
    ['ERROR', 'payment failed'],
  ]);
});

test("the app's own SkeLogger is kept with its levels", async () => {
  useEnv(PLATFORM);
  const logs = await nestRecords({ logger: new SkeLogger({ levels: ['warn', 'error'] }) });
  const orders = logs.filter((log) => log.channel === 'Orders').map((log) => [log.level_name, log.message]);
  assert.deepEqual(orders, [
    ['WARNING', 'stock low'],
    ['ERROR', 'payment failed'],
  ]);
});

test('a second app in the process still gets JSON records once the bridge has set the logger', async () => {
  useEnv(PLATFORM);
  await nestRecords({});
  const logs = await nestRecords({});
  assert.ok(logs.some((log) => log.channel === 'Orders' && log.level_name === 'INFO'), JSON.stringify(logs));
});

test('SKE_LOG_FORMAT=plain leaves Nest\'s logger alone', async () => {
  useEnv({ ...PLATFORM, SKE_LOG_FORMAT: 'plain' });
  assert.deepEqual(await nestRecords({}), []);
});

test('a logger the app set before importing the bridge is kept, with or without the logger option', async () => {
  for (const args of [['option'], []]) {
    const child = spawn(process.execPath, [join(FIXTURES, 'nest-override', 'app.mjs'), ...args], { env: { ...process.env, ...PLATFORM } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'close')) as [number | null];
    assert.equal(code, 0, stderr);
    assert.ok((JSON.parse(stdout.trim()) as string[]).includes('order placed'), `${args.join()}: ${stdout}`);
    assert.deepEqual(records(stderr.split('\n')).filter((log) => log.channel === 'Orders'), [], args.join());
  }
});
