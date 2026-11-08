/**
 * The Express integration:
 *
 *     import express from 'express';
 *     import { bridge } from '@ske-io/bridge/express';
 *
 *     const app = express();
 *     bridge(app);   // before any other middleware or route
 *
 * On the platform it sets `trust proxy` to the one hop the platform puts in
 * front of the app, so `req.ip`, `req.protocol` and `req.hostname` are the
 * client's, and adds the bridge's middleware, which answers the internal
 * routes and maintenance mode before anything the app adds after it. Off the
 * platform it changes nothing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { TRUSTED_HOPS } from './forwarded.js';
import { failNode, nodeRequest, sendNode } from './http.js';
import { activate, handleRequest, type BridgeOptions } from './request.js';

export type { BridgeOptions };
export { client } from './forwarded.js';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/** The part of an Express app the bridge uses. */
export interface ExpressApp {
  set(setting: string, value: unknown): unknown;
  use(handler: Middleware): unknown;
}

export function bridge<App extends ExpressApp>(app: App, options: BridgeOptions = {}): App {
  if (!activate()) {
    return app;
  }
  app.set('trust proxy', TRUSTED_HOPS);
  app.use(middleware(options));
  return app;
}

/**
 * The bridge's middleware alone, for an app that sets `trust proxy` itself.
 * It must come before every other middleware.
 */
export function middleware(options: BridgeOptions = {}): Middleware {
  if (!activate()) {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    handleRequest(nodeRequest(req), options, () => next()).then(
      (response) => {
        if (response !== undefined) sendNode(res, response);
      },
      (error: unknown) => failNode(res, error),
    );
  };
}
