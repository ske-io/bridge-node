import assert from 'node:assert/strict';
import { test } from 'node:test';

import { logger } from '@ske-io/bridge';
import { withBridge } from '@ske-io/bridge/http';

import { captureStderr, PLATFORM, records, useEnv } from './helpers.ts';

test('SKE_LOG_FORMAT=plain leaves the console alone on the platform', async () => {
  useEnv({ ...PLATFORM, SKE_LOG_FORMAT: 'plain' });
  const log = console.log;
  withBridge(() => undefined);
  assert.equal(console.log, log);

  const lines = await captureStderr(() => logger.warning('readable', { order: 7 }));
  assert.deepEqual(records(lines), []);
  assert.match(lines.join('\n'), /^WARNING readable \{ order: 7 \}$/);
});
