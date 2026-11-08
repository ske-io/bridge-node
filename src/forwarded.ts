/**
 * What the platform says about the client, in the headers it forwards.
 *
 * The application listens on a loopback address behind the container's entry
 * process, so every connection it sees comes from 127.0.0.1. The entry
 * process forwards each request with headers it sets itself:
 *
 * - `X-Forwarded-For`: the chain the client sent, with the address the
 *   platform saw the request come from appended last. Only that last entry is
 *   vouched for; everything before it is the client's own claim.
 * - `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Port`: replaced
 *   on every request with the scheme, host and port the client connected
 *   with.
 * - `Forwarded`, `X-Real-IP` and `X-Forwarded-Prefix`: removed.
 *
 * So exactly one proxy hop is trusted, and only on the platform: off it the
 * same headers would be whatever a client chose to send.
 */

import { isIP } from 'node:net';

/** Proxies in front of the application whose forwarded headers are trusted. */
export const TRUSTED_HOPS = 1;

/** The client of one request, as the platform saw it. */
export interface Client {
  /** The client's IP address. */
  readonly address: string | undefined;
  /** The scheme the client connected with. */
  readonly protocol: 'http' | 'https';
  /** The host the client asked for, with its port when it named one. */
  readonly host: string | undefined;
  /** The host without a port. */
  readonly hostname: string | undefined;
  /** The port the client connected to. */
  readonly port: number | undefined;
}

export type HeaderReader = (name: string) => string | undefined;

const clients = new WeakMap<object, Client>();

/** The client from the forwarded headers, trusting the one hop. */
export function forwardedClient(header: HeaderReader, socketAddress: string | undefined): Client {
  const proto = lastEntry(header('x-forwarded-proto'))?.toLowerCase();
  const protocol = proto === 'https' ? 'https' : 'http';
  const host = lastEntry(header('x-forwarded-host')) ?? header('host');
  const port = Number.parseInt(lastEntry(header('x-forwarded-port')) ?? '', 10);

  return {
    address: clientAddress(header('x-forwarded-for')) ?? socketAddress,
    protocol,
    host,
    hostname: host === undefined ? undefined : stripPort(host),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
  };
}

/**
 * The client's address from an `X-Forwarded-For` value: its last entry, the
 * one the platform appended. Undefined when there is none or it is not an IP
 * address.
 */
export function clientAddress(forwardedFor: string | undefined): string | undefined {
  const last = lastEntry(forwardedFor);
  return last !== undefined && isIP(last) !== 0 ? last : undefined;
}

/**
 * The client of a request the bridge handled on the platform: a Node
 * `IncomingMessage` (Express, Koa's `ctx.req`, Fastify's `request.raw`, a
 * plain `http` server) or a web `Request` (Hono's `c.req.raw`). Undefined off
 * the platform, where the forwarded headers are not trusted.
 */
export function client(request: object): Client | undefined {
  return clients.get(request);
}

export function rememberClient(request: object, value: Client): void {
  clients.set(request, value);
}

function lastEntry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const last = value.split(',').pop()?.trim();
  return last ? last : undefined;
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}
