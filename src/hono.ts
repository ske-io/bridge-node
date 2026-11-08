/**
 * The Hono integration, a middleware:
 *
 *     import { Hono } from 'hono';
 *     import { bridge, client } from '@ske-io/bridge/hono';
 *
 *     const app = new Hono();
 *     app.use(bridge());   // before any other middleware or route
 *
 *     app.get('/', (c) => c.text(`hello ${client(c)?.address}`));
 *
 * On the platform it answers the internal routes and maintenance mode before
 * anything the app adds after it. Hono has no proxy setting, so `client(c)`
 * gives the client's address, scheme, host and port from the one hop the
 * platform puts in front of the app. Off the platform it changes nothing and
 * `client(c)` is undefined.
 */

import { client as clientOf, type Client } from './forwarded.js';
import { activate, handleRequest, type BridgeOptions } from './request.js';

export type { BridgeOptions, Client };

/** The part of a Hono context the bridge uses. */
export interface HonoContext {
  req: { raw: Request; header(name: string): string | undefined };
  env?: unknown;
}

export type HonoMiddleware = (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>;

export function bridge(options: BridgeOptions = {}): HonoMiddleware {
  if (!activate()) {
    return async (_c, next) => {
      await next();
    };
  }
  return async (c, next) => {
    const raw = c.req.raw;
    const url = new URL(raw.url);
    const response = await handleRequest(
      {
        method: raw.method,
        url: url.pathname + url.search,
        header: (name) => c.req.header(name) ?? undefined,
        readBody: async () => Buffer.from(await raw.arrayBuffer()),
        socketAddress: socketAddress(c.env),
        key: raw,
        original: c,
      },
      options,
      () => next(),
    );
    if (response !== undefined) {
      return new Response(response.body.length > 0 ? new Uint8Array(response.body) : null, {
        status: response.status,
        headers: response.headers,
      });
    }
  };
}

/** The client of a request the bridge handled, on the platform. */
export function client(c: HonoContext): Client | undefined {
  return clientOf(c.req.raw);
}

/** The connection's address under Node's server, which puts the request in `env.incoming`. */
function socketAddress(env: unknown): string | undefined {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress;
}
