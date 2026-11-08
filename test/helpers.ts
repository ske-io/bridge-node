import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

// These paths are from the compiled tests, in build/test.
export const CLI = fileURLToPath(new URL('../../dist/esm/cli.js', import.meta.url));
/** The fixtures as written: plain JavaScript apps. */
export const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
/** The fixtures compiled from TypeScript (the Nest apps). */
export const BUILT_FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** The variables the platform sets on every function. */
export const PLATFORM = { SKE_PROJECT_TYPE: 'node', SKE_ENVIRONMENT: 'production' };

const PLATFORM_KEYS = [
  'SKE_PROJECT_TYPE',
  'SKE_ENVIRONMENT',
  'MAINTENANCE_MODE',
  'MAINTENANCE_MODE_SECRET',
  'SKE_MAINTENANCE_BYPASS_TOKEN',
  'SKE_LOG_FORMAT',
  'SKE_QUEUE_SYNC',
  'SKE_SCHEDULED_AT',
];

/**
 * Sets the process environment for one test: `values` set, the platform's
 * other variables unset. Restores what was there when the test ends.
 */
export function useEnv(values: Record<string, string | undefined>): void {
  const saved = new Map<string, string | undefined>();
  for (const key of new Set([...PLATFORM_KEYS, ...Object.keys(values)])) {
    saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Serves `listener` on a free loopback port until the test file ends. */
export async function serve(listener: RequestListener | Server): Promise<string> {
  const server = typeof listener === 'function' ? createServer(listener) : listener;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A queue batch as the platform posts it. */
export function batch(records: object[], options: object = {}): string {
  return JSON.stringify({ source: 'sqs', records, options });
}

/** A record holding a job message. */
export function record(messageId: string, job: string, payload: unknown, attempts?: number, id = '6f1c2b8e-4a3d-4e5f-9a7b-1c2d3e4f5a6b'): object {
  return { message_id: messageId, body: JSON.stringify({ job, payload, id }), queue: 'default', ...(attempts === undefined ? {} : { attempts }) };
}

export const INTERNAL = { 'x-ske-internal': 'true', 'content-type': 'application/json' };

/** Captures what is written to stderr while `fn` runs, as lines. */
export async function captureStderr(fn: () => unknown): Promise<string[]> {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return text.split('\n').filter((line) => line !== '');
}

/** The JSON records among lines of output. */
export function records(lines: string[]): Array<Record<string, any>> {
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, any>] : [];
    } catch {
      return [];
    }
  });
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The JSON records written to stderr. */
  logs: Array<Record<string, any>>;
}

/** Runs `ske-bridge` with `args` in `cwd` and the platform's environment plus `env`. */
export async function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', TZ: 'UTC', ...PLATFORM, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr, logs: records(stderr.split('\n')) };
}
