/**
 * Maintenance mode, driven by the platform.
 *
 * The platform puts an environment into maintenance by redeploying it with
 * `MAINTENANCE_MODE=true`, so every instance sees the same state. While it is
 * on, web requests are answered `503 Service Unavailable` with the app's
 * maintenance page, or a minimal page when it has none.
 *
 * What keeps working:
 *
 * - The platform's own requests: the readiness route and delivered jobs
 *   (`/__ske/*`, answered before this check) and anything else the platform
 *   sends with its verified internal header, such as warmup requests.
 * - Visitors the platform lets through from its access list, which it marks
 *   with a header carrying a token only it and the app know.
 * - Whoever has the bypass secret. When `MAINTENANCE_MODE_SECRET` is set,
 *   visiting `/<secret>` sets a cookie and redirects to `/`; the cookie lets
 *   that browser in for 12 hours. It is signed with the secret, so it stops
 *   working when the secret changes, and cannot be made without it.
 *
 * Scheduled entries are skipped while maintenance is on, unless marked to run
 * anyway.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { env, onPlatform } from './env.js';

export const COOKIE = 'ske_maintenance';

/** How long the bypass cookie lets a browser in, in seconds. */
export const LIFETIME = 12 * 60 * 60;

/** The header the platform sets on requests from its access list. */
export const BYPASS_HEADER = 'ske-maintenance-bypass';

/** The page answered when the app has none of its own. */
export const DEFAULT_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Service Unavailable</title></head>' +
  '<body><h1>Service Unavailable</h1>' +
  '<p>This site is down for maintenance. Please try again shortly.</p></body></html>';

/** Where the app's own page is looked for, from the working directory. */
export const PAGE_FILES = ['views/503.html', 'public/503.html'];

/**
 * The app's maintenance page: a file path, or a function returning the page
 * for a request (or undefined for the minimal page).
 */
export type MaintenancePage = string | ((request: unknown) => string | Buffer | undefined | Promise<string | Buffer | undefined>);

export type MaintenanceDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'bypass'; readonly cookie: string }
  | { readonly kind: 'paused' };

export interface MaintenanceRequest {
  readonly path: string;
  readonly cookie: string | undefined;
  readonly secure: boolean;
  /** Whether the request carries the platform's verified internal header. */
  readonly internal: boolean;
  /** The access-list header's value. */
  readonly bypassToken: string | undefined;
}

/** Whether the platform has this environment in maintenance. */
export function maintenanceActive(): boolean {
  return onPlatform() && env('MAINTENANCE_MODE') === 'true';
}

/** What maintenance mode does with a web request. */
export function checkMaintenance(request: MaintenanceRequest): MaintenanceDecision {
  if (request.internal || !maintenanceActive()) {
    return { kind: 'pass' };
  }

  const token = env('SKE_MAINTENANCE_BYPASS_TOKEN');
  if (token !== undefined && request.bypassToken !== undefined && safeEqual(request.bypassToken, token)) {
    return { kind: 'pass' };
  }

  const secret = env('MAINTENANCE_MODE_SECRET');
  if (secret !== undefined) {
    if (safeEqual(trimSlashes(decodePath(request.path)), secret)) {
      return { kind: 'bypass', cookie: bypassCookie(secret, request.secure) };
    }
    if (hasValidCookie(request.cookie, secret)) {
      return { kind: 'pass' };
    }
  }

  return { kind: 'paused' };
}

/**
 * The maintenance page for a request: the app's own, else the minimal one. A
 * page file is read once per process, found or not: it is fixed per deploy,
 * and every request during maintenance would read it again.
 */
export async function maintenancePage(page: MaintenancePage | undefined, request: unknown): Promise<Buffer> {
  try {
    if (typeof page === 'function') {
      const rendered = await page(request);
      if (rendered !== undefined) return Buffer.from(rendered);
    } else {
      const found = await pageFile(page === undefined ? PAGE_FILES : [page]);
      if (found !== null) return found;
    }
  } catch {
    // A page that fails to render must not turn the 503 into a 500.
  }
  return Buffer.from(DEFAULT_PAGE);
}

const pageFiles = new Map<string, Promise<Buffer | null>>();

/** The first of `files` that exists, from the working directory, read once. */
function pageFile(files: string[]): Promise<Buffer | null> {
  const paths = files.map((file) => resolve(file));
  const key = paths.join('\0');
  let found = pageFiles.get(key);
  if (found === undefined) {
    found = (async () => {
      for (const path of paths) {
        try {
          return await readFile(path);
        } catch {
          // Not there; try the next one.
        }
      }
      return null;
    })();
    pageFiles.set(key, found);
  }
  return found;
}

/** Constant-time comparison of two strings. */
export function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Compared against itself when the lengths differ, so the time taken does
  // not depend on how much of the value matched.
  return timingSafeEqual(a.length === b.length ? a : b, b) && a.length === b.length;
}

function bypassCookie(secret: string, secure: boolean): string {
  const expires = Math.floor(Date.now() / 1000) + LIFETIME;
  const value = Buffer.from(JSON.stringify({ expires_at: expires, mac: mac(secret, expires) })).toString('base64url');
  const attributes = [`${COOKIE}=${value}`, 'Path=/', `Max-Age=${LIFETIME}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function hasValidCookie(header: string | undefined, secret: string): boolean {
  const value = cookieValue(header, COOKIE);
  if (value === undefined) return false;
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString()) as { expires_at?: unknown; mac?: unknown };
    const expires = payload.expires_at;
    if (typeof expires !== 'number' || !Number.isInteger(expires) || typeof payload.mac !== 'string') return false;
    return safeEqual(payload.mac, mac(secret, expires)) && Date.now() / 1000 < expires;
  } catch {
    return false;
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function mac(secret: string, expires: number): string {
  return createHmac('sha256', secret).update(String(expires)).digest('hex');
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
