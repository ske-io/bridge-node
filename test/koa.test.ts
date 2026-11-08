import assert from 'node:assert/strict';
import { test } from 'node:test';

import Koa from 'koa';

import { bridge } from '@ske-io/bridge/koa';

import { conformance } from './conformance.ts';
import { PLATFORM, serve, useEnv } from './helpers.ts';

conformance('koa', async (options) => {
  const app = new Koa();
  bridge(app, options);
  app.use(async (ctx, next) => {
    if (ctx.get('authorization') !== 'let-me-in') {
      ctx.status = 401;
      return;
    }
    await next();
  });
  app.use(async (ctx) => {
    if (ctx.path === '/whoami') {
      ctx.body = { ip: ctx.ip, protocol: ctx.protocol, hostname: ctx.hostname };
    } else if (ctx.path === '/log') {
      await new Promise((resolve) => setTimeout(resolve, 1));
      console.log('handled');
      ctx.status = 204;
    }
  });
  return serve(app.callback());
});

test('koa: on the platform the client is read from X-Forwarded-For, whatever header the app chose', async () => {
  useEnv(PLATFORM);
  const app = new Koa({ proxyIpHeader: 'X-Client-IP' });
  bridge(app);
  assert.equal(app.proxyIpHeader, 'X-Forwarded-For');
  app.use((ctx) => {
    ctx.body = { ip: ctx.ip };
  });
  const url = await serve(app.callback());
  const response = await fetch(`${url}/`, { headers: { 'x-client-ip': '203.0.113.66', 'x-forwarded-for': '198.51.100.7' } });
  assert.deepEqual(await response.json(), { ip: '198.51.100.7' });
});

test("koa: off the platform the app's proxy settings are left as they are", () => {
  useEnv({});
  const app = new Koa({ proxy: true, proxyIpHeader: 'X-Client-IP', maxIpsCount: 3 });
  bridge(app);
  assert.deepEqual([app.proxy, app.proxyIpHeader, app.maxIpsCount], [true, 'X-Client-IP', 3]);
});
