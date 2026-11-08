/**
 * What every web integration must do, run against each framework.
 *
 * Each framework's test builds an app with:
 * - the bridge installed first,
 * - then a catch-all guard answering 401 to any request without
 *   `authorization: let-me-in`, standing for the app's authentication,
 * - `GET /whoami`: the client as the framework itself reports it,
 *   `{ ip, protocol, hostname }`,
 * - `GET /log`: writes `console.log('handled')` after an await, then 204.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { defineJob } from '@ske-io/bridge';

import { batch, captureStderr, FIXTURES, INTERNAL, PLATFORM, record, records, useEnv } from './helpers.ts';

export interface AppOptions {
  maintenancePage?: string;
}

/** Builds the app as described above and serves it; resolves to its URL. */
export type MakeApp = (options: AppOptions) => Promise<string>;

const AUTH = { authorization: 'let-me-in' };
const PAGE = join(FIXTURES, 'maintenance.html');

export function conformance(name: string, makeApp: MakeApp): void {
  test(`${name}: off the platform nothing changes`, async () => {
    useEnv({});
    const url = await makeApp({});
    assert.equal((await fetch(`${url}/__ske/health`)).status, 401);
    const whoami = await fetch(`${url}/whoami`, { headers: { ...AUTH, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' } });
    const client = (await whoami.json()) as { ip: string; protocol: string };
    assert.notEqual(client.ip, '203.0.113.9');
    assert.equal(client.protocol, 'http');
  });

  test(`${name}: the internal routes are answered before the app's middleware`, async () => {
    useEnv(PLATFORM);
    const url = await makeApp({});

    const health = await fetch(`${url}/__ske/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const head = await fetch(`${url}/__ske/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    assert.equal((await fetch(`${url}/__ske/queue`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${url}/__ske/other`, { headers: INTERNAL })).status, 404);

    const ran: unknown[] = [];
    defineJob(`${name}-job`, (payload) => {
      ran.push(payload);
    });
    const queue = await fetch(`${url}/__ske/queue`, { method: 'POST', headers: INTERNAL, body: batch([record('m1', `${name}-job`, { n: 1 })]) });
    assert.equal(queue.status, 200);
    const reply = (await queue.json()) as { processed: number; outcomes: Array<{ deleted: boolean }> };
    assert.equal(reply.processed, 1);
    assert.equal(reply.outcomes[0]?.deleted, true);
    assert.deepEqual(ran, [{ n: 1 }]);

    assert.equal((await fetch(`${url}/whoami`)).status, 401, 'the guard still guards the app');
  });

  test(`${name}: the client comes from the one hop the platform adds`, async () => {
    useEnv(PLATFORM);
    const url = await makeApp({});
    const response = await fetch(`${url}/whoami`, {
      headers: {
        ...AUTH,
        'x-forwarded-for': '203.0.113.9, 198.51.100.7',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'shop.example.com',
        'x-forwarded-port': '443',
      },
    });
    assert.deepEqual(await response.json(), { ip: '198.51.100.7', protocol: 'https', hostname: 'shop.example.com' });
  });

  test(`${name}: log records are JSON on stderr with the request's id, only during the request`, async () => {
    useEnv(PLATFORM);
    const url = await makeApp({});
    const lines = await captureStderr(async () => {
      const response = await fetch(`${url}/log`, { headers: { ...AUTH, 'x-request-id': 'req-123' } });
      assert.equal(response.status, 204);
      await sleep(5);
      console.log('outside');
    });
    const logs = records(lines);
    const handled = logs.find((log) => log.message === 'handled');
    assert.equal(handled?.context.request_id, 'req-123');
    assert.equal(handled?.level_name, 'INFO');
    assert.deepEqual(Object.keys(handled ?? {}).sort(), ['channel', 'context', 'datetime', 'extra', 'level_name', 'message']);
    const outside = logs.find((log) => log.message === 'outside');
    assert.equal(outside?.context.request_id, undefined);
  });

  test(`${name}: maintenance mode answers 503 with the app's page, and lets the platform and bypasses in`, async () => {
    useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true', MAINTENANCE_MODE_SECRET: 's3cret', SKE_MAINTENANCE_BYPASS_TOKEN: 'token-1' });
    const url = await makeApp({ maintenancePage: PAGE });

    const paused = await fetch(`${url}/whoami`, { headers: AUTH });
    assert.equal(paused.status, 503);
    assert.match(paused.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await paused.text(), /Back soon/);

    assert.equal((await fetch(`${url}/__ske/health`)).status, 200, 'readiness keeps working');

    const marked = await fetch(`${url}/whoami`, { headers: { ...AUTH, 'x-ske-internal': 'true' } });
    assert.equal(marked.status, 200, 'the verified internal marker bypasses');
    assert.equal((await fetch(`${url}/whoami`, { headers: { ...AUTH, 'x-ske-internal': 'yes' } })).status, 503);

    assert.equal((await fetch(`${url}/whoami`, { headers: { ...AUTH, 'ske-maintenance-bypass': 'token-1' } })).status, 200);
    assert.equal((await fetch(`${url}/whoami`, { headers: { ...AUTH, 'ske-maintenance-bypass': 'token-2' } })).status, 503);

    const visit = await fetch(`${url}/s3cret`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(visit.status, 302);
    assert.equal(visit.headers.get('location'), '/');
    const cookie = visit.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^ske_maintenance=[^;]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure$/);
    const pair = cookie.split(';')[0] as string;
    assert.equal((await fetch(`${url}/whoami`, { headers: { ...AUTH, cookie: pair } })).status, 200);

    process.env.MAINTENANCE_MODE_SECRET = 'rotated';
    assert.equal((await fetch(`${url}/whoami`, { headers: { ...AUTH, cookie: pair } })).status, 503, 'a new secret ends old cookies');
    process.env.MAINTENANCE_MODE_SECRET = 's3cret';

    process.env.MAINTENANCE_MODE = 'false';
    assert.equal((await fetch(`${url}/whoami`, { headers: AUTH })).status, 200);
  });
}
