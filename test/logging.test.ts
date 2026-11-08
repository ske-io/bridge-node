import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger, logger, withRequestId } from '@ske-io/bridge';
import { withBridge } from '@ske-io/bridge/http';
import { SkeLogger } from '@ske-io/bridge/nest';

import { captureStderr, PLATFORM, records, useEnv } from './helpers.ts';

useEnv(PLATFORM);
// Installing an integration on the platform makes the console write records.
withBridge(() => undefined);

test('every level the logs page knows is written, uppercase', async () => {
  const lines = await captureStderr(() => {
    const log = createLogger('orders');
    log.debug('d');
    log.info('i');
    log.notice('n');
    log.warning('w');
    log.error('e');
    log.critical('c');
    log.alert('a');
    log.emergency('em');
  });
  const logs = records(lines);
  assert.deepEqual(
    logs.map((log) => log.level_name),
    ['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'],
  );
  assert.ok(logs.every((log) => log.channel === 'orders'));
  assert.match(logs[0]?.datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
  assert.deepEqual(logs[0]?.extra, {});
});

test('console methods map to levels, and every record is one line', async () => {
  const lines = await captureStderr(() => {
    console.debug('debugging');
    console.log('line one\nline two');
    console.info('info %d', 42);
    console.warn('careful');
    console.error('broken');
  });
  assert.equal(lines.length, 5);
  assert.deepEqual(
    records(lines).map((log) => [log.level_name, log.message, log.channel]),
    [
      ['DEBUG', 'debugging', 'console'],
      ['INFO', 'line one\nline two', 'console'],
      ['INFO', 'info 42', 'console'],
      ['WARNING', 'careful', 'console'],
      ['ERROR', 'broken', 'console'],
    ],
  );
});

test("an error becomes context.exception with its class, file, trace and cause", async () => {
  class PaymentError extends Error {}
  const cause = new RangeError('card expired');
  const error = new PaymentError('payment failed\nsee cause', { cause });

  const lines = await captureStderr(() => {
    console.error('checkout failed', error);
    logger.error('again', { exception: error, order: 7 });
  });
  const [first, second] = records(lines);

  assert.equal(first?.message, 'checkout failed');
  const exception = first?.context.exception;
  assert.equal(exception.class, 'PaymentError');
  assert.equal(exception.message, 'payment failed\nsee cause');
  assert.match(exception.file, /logging\.test\.js:\d+$/);
  assert.ok(Array.isArray(exception.trace) && exception.trace.every((frame: string) => /:\d+$/.test(frame)));
  assert.equal(exception.previous.class, 'RangeError');
  assert.equal(exception.previous.message, 'card expired');

  assert.equal(second?.context.order, 7);
  assert.equal(second?.context.exception.class, 'PaymentError');
});

test('records carry the request id only inside the request', async () => {
  const lines = await captureStderr(async () => {
    await withRequestId('abc', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info('inside');
    });
    logger.info('after');
  });
  const [inside, outside] = records(lines);
  assert.equal(inside?.context.request_id, 'abc');
  assert.equal(outside?.context.request_id, undefined);
});

test("Nest's logger levels map to the platform's, with the context as channel", async () => {
  const nest = new SkeLogger();
  const lines = await captureStderr(() => {
    nest.log('started', 'Bootstrap');
    nest.verbose('detail');
    nest.debug('debug', 'Orders');
    nest.warn('slow', 'Orders');
    nest.error('failed', 'Error: failed\n    at main (/app/dist/main.js:3:9)', 'Orders');
    nest.fatal('down', 'Orders');
  });
  const logs = records(lines);
  assert.deepEqual(
    logs.map((log) => [log.level_name, log.channel]),
    [
      ['INFO', 'Bootstrap'],
      ['DEBUG', 'nest'],
      ['DEBUG', 'Orders'],
      ['WARNING', 'Orders'],
      ['ERROR', 'Orders'],
      ['CRITICAL', 'Orders'],
    ],
  );
  assert.equal(logs[4]?.context.exception.file, '/app/dist/main.js:3');
});

test('circular and BigInt context values never break a record', async () => {
  const context: Record<string, unknown> = { big: 10n };
  context.self = context;
  const lines = await captureStderr(() => logger.info('odd', context));
  const logged = records(lines)[0]?.context;
  assert.equal(logged?.big, '10');
  assert.equal(logged?.self.self, '[Circular]');
});

test("Nest's logger levels filter by the Nest method, one level at a time", async () => {
  const methods = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
  const expected = { log: 'INFO', error: 'ERROR', warn: 'WARNING', debug: 'DEBUG', verbose: 'DEBUG', fatal: 'CRITICAL' };
  for (const level of methods) {
    const nest = new SkeLogger({ levels: [level] });
    const lines = await captureStderr(() => {
      for (const method of methods) nest[method](`via ${method}`, 'Filter');
    });
    assert.deepEqual(
      records(lines).map((log) => [log.message, log.level_name]),
      [[`via ${level}`, expected[level]]],
      level,
    );
  }
});
