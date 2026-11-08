import { Hono } from 'hono';

import { bridge, client } from '@ske-io/bridge/hono';

import { conformance } from './conformance.ts';
import { serve } from './helpers.ts';

conformance('hono', async (options) => {
  const app = new Hono();
  app.use(bridge(options));
  app.use(async (c, next) => {
    if (c.req.header('authorization') !== 'let-me-in') return c.body(null, 401);
    await next();
  });
  app.get('/whoami', (c) => {
    // Hono has no proxy setting: off the platform the app reads the URL.
    const forwarded = client(c);
    return c.json(
      forwarded
        ? { ip: forwarded.address, protocol: forwarded.protocol, hostname: forwarded.hostname }
        : { ip: null, protocol: new URL(c.req.url).protocol.replace(':', ''), hostname: new URL(c.req.url).hostname },
    );
  });
  app.get('/log', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    console.log('handled');
    return c.body(null, 204);
  });
  return serve(nodeHandler(app.fetch));
});

/** A minimal Node adapter for a fetch handler, so the test needs no server package. */
function nodeHandler(fetchHandler: (request: Request) => Response | Promise<Response>) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const method = req.method ?? 'GET';
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await fetchHandler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
