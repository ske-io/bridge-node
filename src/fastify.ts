/**
 * The Fastify integration, a plugin:
 *
 *     import Fastify from 'fastify';
 *     import { bridge } from '@ske-io/bridge/fastify';
 *
 *     const app = Fastify();
 *     await app.register(bridge);   // before the app's own plugins and hooks
 *
 * On the platform it adds an `onRequest` hook to the root instance that
 * answers the internal routes and maintenance mode before routing and the
 * app's hooks, and makes `request.ip`, `request.protocol`, `request.host`,
 * `request.hostname` and `request.port` the client's, trusting exactly the
 * one hop the platform puts in front of the app, whatever `trustProxy` says.
 * Off the platform it changes nothing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { nodeRequest } from './http.js';
import { activate, handleRequest, type BridgeOptions } from './request.js';

export type { BridgeOptions };
export { client } from './forwarded.js';

/** The part of a Fastify request the bridge uses. */
export interface FastifyRequestLike {
  raw: IncomingMessage;
}

/** The part of a Fastify reply the bridge uses. */
export interface FastifyReplyLike {
  raw: ServerResponse;
  code(status: number): FastifyReplyLike;
  headers(values: Record<string, string>): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

/** The part of a Fastify instance the bridge uses. */
export interface FastifyInstanceLike {
  addHook(
    name: 'onRequest',
    hook: (request: FastifyRequestLike, reply: FastifyReplyLike, done: (error?: Error) => void) => void,
  ): unknown;
}

/** Applies to the instance it is registered on, not a child of it. */
const SKIP_OVERRIDE = Symbol.for('skip-override');

export interface BridgePlugin {
  (instance: FastifyInstanceLike, options: BridgeOptions): Promise<void>;
  [SKIP_OVERRIDE]: true;
}

export const bridge: BridgePlugin = Object.assign(
  async (instance: FastifyInstanceLike, options: BridgeOptions = {}) => {
    if (!activate()) {
      return;
    }
    instance.addHook('onRequest', (request, reply, done) => {
      handleRequest(nodeRequest(request.raw, request), options, (client) => {
        overrideRequest(request, {
          ip: client.address,
          protocol: client.protocol,
          host: client.host,
          hostname: client.hostname,
          port: client.port ?? (client.protocol === 'https' ? 443 : 80),
        });
        done();
      }).then(
        (response) => {
          if (response !== undefined) {
            reply.code(response.status).headers(response.headers).send(response.body);
          }
        },
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    });
  },
  { [SKIP_OVERRIDE]: true as const },
);

/** Shadows the request's own getters with the client's values. */
function overrideRequest(request: object, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      Object.defineProperty(request, name, { value, configurable: true, enumerable: false, writable: false });
    }
  }
}
