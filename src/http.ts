/**
 * The bridge around a plain Node request handler, for a server made with
 * `http.createServer` or any framework that hands you one:
 *
 *     import { createServer } from 'node:http';
 *     import { withBridge } from '@ske-io/bridge/http';
 *
 *     createServer(withBridge((req, res) => { ... })).listen(process.env.PORT ?? 3000);
 *
 * Off the platform the handler is returned as it is.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { exceptionRecord, bridgeLog } from './logging.js';
import { activate, handleRequest, nodeHeader, readStream, type BridgeOptions, type IncomingRequest, type Response } from './request.js';

export type { BridgeOptions };
export { client } from './forwarded.js';

export type RequestListener<Req extends IncomingMessage = IncomingMessage, Res extends ServerResponse = ServerResponse> = (
  req: Req,
  res: Res,
) => unknown;

export function withBridge<Req extends IncomingMessage, Res extends ServerResponse>(
  handler: RequestListener<Req, Res>,
  options: BridgeOptions = {},
): RequestListener<Req, Res> {
  if (!activate()) {
    return handler;
  }

  return (req, res) => {
    handleRequest(nodeRequest(req), options, () => handler(req, res)).then(
      (response) => {
        if (response !== undefined) sendNode(res, response);
      },
      (error: unknown) => failNode(res, error),
    );
  };
}

/** A Node request as the bridge reads it. */
export function nodeRequest(req: IncomingMessage, original: unknown = req): IncomingRequest {
  return {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    header: (name) => nodeHeader(req.headers, name),
    readBody: () => readStream(req),
    socketAddress: req.socket?.remoteAddress,
    key: req,
    original,
  };
}

export function sendNode(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

export function failNode(res: ServerResponse, error: unknown): void {
  bridgeLog.error('The request could not be handled', { exception: exceptionRecord(error) });
  if (!res.headersSent) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
  }
  res.end();
}
