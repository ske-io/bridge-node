import assert from 'node:assert/strict';
import { test } from 'node:test';

import { client, withBridge } from '@ske-io/bridge/http';

import { PLATFORM, serve, useEnv } from './helpers.ts';

const app = withBridgeApp();

function withBridgeApp() {
  return (options = {}) =>
    withBridge((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: true, path: req.url, client: client(req) ?? null }));
    }, options);
}

test('off the platform the handler is returned unchanged and the internal routes are the app\'s', async () => {
  useEnv({});
  const handler = (_req: unknown, res: { end(body: string): void }) => res.end('app');
  assert.equal(withBridge(handler as never), handler);

  const url = await serve(app());
  const response = await fetch(`${url}/__ske/health`);
  assert.equal(await response.text(), JSON.stringify({ app: true, path: '/__ske/health', client: null }));
});

test('either platform variable activates the bridge', async () => {
  for (const variable of ['SKE_PROJECT_TYPE', 'SKE_ENVIRONMENT']) {
    process.env[variable] = 'x';
    const url = await serve(app());
    const response = await fetch(`${url}/__ske/health`);
    assert.deepEqual(await response.json(), { status: 'ok' }, variable);
    delete process.env[variable];
  }
});

test('health answers GET and HEAD with 200 and no marker needed', async () => {
  useEnv(PLATFORM);
  const url = await serve(app());

  const get = await fetch(`${url}/__ske/health`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { status: 'ok' });

  const head = await fetch(`${url}/__ske/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const post = await fetch(`${url}/__ske/health`, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('the queue route answers 404 without the exact internal marker', async () => {
  useEnv(PLATFORM);
  const url = await serve(app());
  for (const marker of [undefined, '', 'false', 'TRUE', 'true, true', '1']) {
    const response = await fetch(`${url}/__ske/queue`, {
      method: 'POST',
      headers: marker === undefined ? {} : { 'x-ske-internal': marker },
      body: '{}',
    });
    assert.equal(response.status, 404, String(marker));
  }
});

test('unknown internal paths answer 404, even with the marker, and never reach the app', async () => {
  useEnv(PLATFORM);
  const url = await serve(app());
  for (const path of ['/__ske/cli', '/__ske/scheduler', '/__ske/', '/__ske/health/x']) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'x-ske-internal': 'true' } });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
});

test('an unreadable batch answers 400 so the platform delivers it again', async () => {
  useEnv(PLATFORM);
  const url = await serve(app());
  const response = await fetch(`${url}/__ske/queue`, { method: 'POST', headers: { 'x-ske-internal': 'true' }, body: 'not json' });
  assert.equal(response.status, 400);
});

test('other requests reach the app with the client from the one trusted hop', async () => {
  useEnv(PLATFORM);
  const url = await serve(app());
  const response = await fetch(`${url}/orders?x=1`, {
    headers: {
      'x-forwarded-for': '203.0.113.9, 198.51.100.7',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'shop.example.com',
      'x-forwarded-port': '443',
    },
  });
  assert.deepEqual(await response.json(), {
    app: true,
    path: '/orders?x=1',
    client: { address: '198.51.100.7', protocol: 'https', host: 'shop.example.com', hostname: 'shop.example.com', port: 443 },
  });
});
