import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import * as esm from '@ske-io/bridge';

import { useEnv } from './helpers.ts';

const require = createRequire(import.meta.url);

test('the CommonJS and ES module builds share one set of jobs and tasks', async () => {
  useEnv({ SKE_QUEUE_SYNC: '1' });
  const cjs = require('@ske-io/bridge') as typeof esm;
  assert.notEqual(cjs.dispatch, esm.dispatch, 'two builds are loaded');

  const ran: unknown[] = [];
  cjs.defineJob('shared-job', (payload) => {
    ran.push(payload);
  });
  await esm.dispatch('shared-job', { from: 'esm' });
  assert.deepEqual(ran, [{ from: 'esm' }]);
  assert.throws(() => esm.defineJob('shared-job', () => undefined), /already defined/);
});

test('every entry point loads in both formats', async () => {
  for (const entry of ['', '/express', '/fastify', '/koa', '/hono', '/http', '/nest']) {
    const name = `@ske-io/bridge${entry}`;
    assert.equal(typeof require(name), 'object', `require ${name}`);
    assert.equal(typeof (await import(name)), 'object', `import ${name}`);
  }
});

test('CI tests the declared minimum Node exactly', () => {
  const root = new URL('../../', import.meta.url);
  const engines = (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { engines: { node: string } }).engines.node;
  const minimum = /^>=(\d+\.\d+)$/.exec(engines)?.[1];
  assert.ok(minimum !== undefined, `engines.node is ${engines}`);
  const workflow = readFileSync(new URL('.github/workflows/tests.yml', root), 'utf8');
  const matrix = /node: \[([^\]]*)\]/.exec(workflow)?.[1] ?? '';
  assert.ok(matrix.includes(`'${minimum}.0'`), `the CI matrix [${matrix}] lacks ${minimum}.0`);
});
