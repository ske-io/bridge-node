/**
 * The Koa integration:
 *
 *     import Koa from 'koa';
 *     import { bridge } from '@ske-io/bridge/koa';
 *
 *     const app = new Koa();
 *     bridge(app);   // before any other middleware
 *
 * On the platform it sets `app.proxy`, `proxyIpHeader = 'X-Forwarded-For'`
 * and `maxIpsCount = 1`, trusting the
 * one hop the platform puts in front of the app, so `ctx.ip`, `ctx.protocol`
 * and `ctx.host` are the client's, and adds the bridge's middleware, which
 * answers the internal routes and maintenance mode before anything the app
 * adds after it. Off the platform it changes nothing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { TRUSTED_HOPS } from './forwarded.js';
import { nodeRequest } from './http.js';
import { activate, handleRequest, type BridgeOptions } from './request.js';

export type { BridgeOptions };
export { client } from './forwarded.js';

/** The part of a Koa context the bridge uses. */
export interface KoaContext {
  req: IncomingMessage;
  res: ServerResponse;
  status: number;
  body: unknown;
  set(field: Record<string, string>): void;
}

export type KoaMiddleware = (ctx: KoaContext, next: () => Promise<unknown>) => Promise<void>;

/** The part of a Koa app the bridge uses. */
export interface KoaApp {
  proxy: boolean;
  proxyIpHeader: string;
  maxIpsCount: number;
  use(middleware: KoaMiddleware): unknown;
}

export function bridge<App extends KoaApp>(app: App, options: BridgeOptions = {}): App {
  if (!activate()) {
    return app;
  }
  // The header is the platform's: an app's own choice of header would let a
  // client set its address by sending that header.
  app.proxy = true;
  app.proxyIpHeader = 'X-Forwarded-For';
  app.maxIpsCount = TRUSTED_HOPS;
  app.use(middleware(options));
  return app;
}

/** The bridge's middleware alone. It must come before every other middleware. */
export function middleware(options: BridgeOptions = {}): KoaMiddleware {
  if (!activate()) {
    return async (_ctx, next) => {
      await next();
    };
  }
  return async (ctx, next) => {
    const response = await handleRequest(nodeRequest(ctx.req, ctx), options, () => next());
    if (response === undefined) return;
    const { 'content-length': _length, ...headers } = response.headers;
    ctx.status = response.status;
    ctx.set(headers);
    ctx.body = response.body;
  };
}
