import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { maintenanceActive } from '@ske-io/bridge';
import { withBridge } from '@ske-io/bridge/http';

import { batch, INTERNAL, PLATFORM, serve, useEnv } from './helpers.ts';

const app = () => withBridge((_req, res) => res.end('app'));

test('without a page of its own the app answers a minimal one, uncached, with no body for HEAD', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  const url = await serve(app());
  const response = await fetch(`${url}/`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /down for maintenance/);
  const head = await fetch(`${url}/`, { method: 'HEAD' });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), '');
});

test('a page function renders the page for the request; one that throws falls back', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  const rendered = await serve(withBridge((_req, res) => res.end(), { maintenancePage: (req) => `<p>${(req as { url: string }).url}</p>` }));
  assert.equal(await (await fetch(`${rendered}/shop`)).text(), '<p>/shop</p>');

  const failing = await serve(
    withBridge((_req, res) => res.end(), {
      maintenancePage: () => {
        throw new Error('template broke');
      },
    }),
  );
  const response = await fetch(`${failing}/`);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /down for maintenance/);
});

test('without a secret there is no bypass path, and a forged or expired cookie is refused', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true', MAINTENANCE_MODE_SECRET: 's3cret' });
  const url = await serve(app());
  const forged = Buffer.from(JSON.stringify({ expires_at: Math.floor(Date.now() / 1000) + 600, mac: 'x' })).toString('base64url');
  assert.equal((await fetch(`${url}/`, { headers: { cookie: `ske_maintenance=${forged}` } })).status, 503);
  assert.equal((await fetch(`${url}/s3cret-not`, { redirect: 'manual' })).status, 503);

  const visit = await fetch(`${url}/s3cret/`, { redirect: 'manual' });
  assert.equal(visit.status, 302);
  assert.doesNotMatch(visit.headers.get('set-cookie') ?? '', /Secure/, 'plain HTTP gets no Secure flag');
});

test('maintenance is only on when the platform says so', () => {
  useEnv({ MAINTENANCE_MODE: 'true' });
  assert.equal(maintenanceActive(), false);
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'false' });
  assert.equal(maintenanceActive(), false);
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  assert.equal(maintenanceActive(), true);
});

test('delivered jobs still run in maintenance mode', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  const url = await serve(app());
  const response = await fetch(`${url}/__ske/queue`, { method: 'POST', headers: INTERNAL, body: batch([]) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { processed: 0, outcomes: [] });
});

test('the access-list header lets nobody in when the app has no token', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  const url = await serve(app());
  for (const value of ['', 'anything']) {
    assert.equal((await fetch(`${url}/`, { headers: { 'ske-maintenance-bypass': value } })).status, 503, JSON.stringify(value));
  }
});

test('the maintenance page file is read once, not for every request', async () => {
  useEnv({ ...PLATFORM, MAINTENANCE_MODE: 'true' });
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-'));
  try {
    const file = join(dir, '503.html');
    await writeFile(file, '<p>first</p>');
    const url = await serve(withBridge((_req, res) => res.end(), { maintenancePage: file }));
    assert.equal(await (await fetch(`${url}/`)).text(), '<p>first</p>');
    // The deploy fixes the page; a request no longer touches the disk.
    await rm(file);
    assert.equal(await (await fetch(`${url}/`)).text(), '<p>first</p>');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
