/**
 * What the bridge does with one web request, independent of any framework.
 * Each integration turns its framework's request into an IncomingRequest,
 * calls handleRequest() first thing, and either sends the response it gets
 * or lets the application have the request.
 *
 * In order:
 *
 * 1. The client's address, scheme, host and port are read from the one
 *    trusted hop's headers (see forwarded) and kept for client().
 * 2. `/__ske/*` is answered by the internal routes.
 * 3. Maintenance mode answers 503, or sets the bypass cookie.
 * 4. Everything else goes to the application, as part of the request whose
 *    id the platform sent in `X-Request-Id`, so its log records carry it.
 *
 * Integrations only call this on the platform; off it they change nothing.
 */

import { onPlatform } from './env.js';
import { forwardedClient, rememberClient, type Client } from './forwarded.js';
import { useStructuredLogs, withRequestId } from './logging.js';
import { BYPASS_HEADER, checkMaintenance, maintenancePage, type MaintenancePage } from './maintenance.js';
import { answerInternal, INTERNAL_HEADER, isInternal, isInternalPath } from './routes.js';

export interface BridgeOptions {
  /**
   * The app's maintenance page: a file, or a function rendering it for a
   * request. By default `views/503.html`, then `public/503.html`, from the
   * working directory; a minimal page when neither exists.
   */
  maintenancePage?: MaintenancePage;
}

export interface IncomingRequest {
  readonly method: string;
  /** The request target: path and query. */
  readonly url: string;
  header(name: string): string | undefined;
  readBody(): Promise<Buffer>;
  readonly socketAddress: string | undefined;
  /** The object client() looks the request up by. */
  readonly key: object;
  /** The framework's own request, handed to a maintenance page function. */
  readonly original: unknown;
}

export interface Response {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/**
 * Whether the integration should act: on the platform. Also sets up the
 * structured logs, once.
 */
export function activate(): boolean {
  if (!onPlatform()) return false;
  useStructuredLogs();
  return true;
}

/**
 * Handles the request, and calls `next` (as part of the request) when the
 * application is to answer it. Resolves to the response to send instead, or
 * to undefined once `next` has been called.
 */
export async function handleRequest<T>(
  request: IncomingRequest,
  options: BridgeOptions,
  next: (client: Client) => T | Promise<T>,
): Promise<Response | undefined> {
  return withRequestId(request.header('x-request-id') || undefined, async (): Promise<Response | undefined> => {
    const client = forwardedClient((name) => request.header(name), request.socketAddress);
    rememberClient(request.key, client);

    const path = pathOf(request.url);
    const head = request.method === 'HEAD';

    if (isInternalPath(path)) {
      const reply = await answerInternal(request.method, path, request.header(INTERNAL_HEADER), () => request.readBody());
      const body = Buffer.from(JSON.stringify(reply.body));
      return {
        status: reply.status,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'cache-control': 'no-store' },
        body: head ? Buffer.alloc(0) : body,
      };
    }

    const decision = checkMaintenance({
      path,
      cookie: request.header('cookie'),
      secure: client.protocol === 'https',
      internal: isInternal(request.header(INTERNAL_HEADER)),
      bypassToken: request.header(BYPASS_HEADER),
    });

    if (decision.kind === 'bypass') {
      return {
        status: 302,
        headers: { location: '/', 'set-cookie': decision.cookie, 'content-length': '0', 'cache-control': 'no-store' },
        body: Buffer.alloc(0),
      };
    }
    if (decision.kind === 'paused') {
      const page = await maintenancePage(options.maintenancePage, request.original);
      return {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(page.length), 'cache-control': 'no-store' },
        body: head ? Buffer.alloc(0) : page,
      };
    }

    await next(client);
    return undefined;
  });
}

/** Reads a Node request's whole body. */
export async function readStream(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/** A header from Node's header object, joined when it was sent more than once. */
export function nodeHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return path === '' ? '/' : path;
}
