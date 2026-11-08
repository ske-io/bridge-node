/**
 * The platform's mail service.
 *
 * When a mail service is attached to the environment, the platform sets
 * `MAIL_MAILER=smtp`, `MAIL_HOST` and `MAIL_PORT`. The catching service runs
 * an SMTP server inside the container that keeps every mail the application
 * sends from reaching a real inbox. It speaks plain SMTP, with no TLS and no
 * login, which `MAIL_ENCRYPTION` being empty says.
 *
 * mailTransport() turns this into SMTP options for nodemailer (and any client
 * taking the same option names). They replace the application's own SMTP
 * settings on the platform: the service is attached to keep mail from going
 * out, and the application's real server would let it out.
 */

import { env, onPlatform } from './env.js';
import { bridgeLog } from './logging.js';

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the first byte (SMTPS). */
  secure: boolean;
  /** Never upgrade with STARTTLS. */
  ignoreTLS?: boolean;
  /** Refuse to send unless STARTTLS succeeds. */
  requireTLS?: boolean;
  auth?: { user: string; pass: string };
}

/**
 * The platform's SMTP transport options when it gives the application one,
 * else `fallback` (undefined by default), which is how the application
 * sends elsewhere:
 *
 *     nodemailer.createTransport(mailTransport({ host: 'smtp.example.com', port: 587, ... }))
 */
export function mailTransport(): SmtpOptions | undefined;
export function mailTransport<T>(fallback: T): SmtpOptions | T;
export function mailTransport<T>(fallback?: T): SmtpOptions | T | undefined {
  if (!onPlatform() || env('MAIL_MAILER')?.toLowerCase() !== 'smtp') {
    return fallback;
  }

  const host = env('MAIL_HOST');
  const port = env('MAIL_PORT');
  if (host === undefined || port === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(port)) {
    bridgeLog.warning(`MAIL_PORT ${JSON.stringify(port)} is not a port; the application's mail settings are used`);
    return fallback;
  }

  const encryption = env('MAIL_ENCRYPTION')?.toLowerCase();
  if (encryption === undefined) {
    return { host, port: Number(port), secure: false, ignoreTLS: true };
  }

  const options: SmtpOptions = { host, port: Number(port), secure: encryption === 'ssl' || encryption === 'smtps' };
  if (!options.secure) options.requireTLS = true;
  const user = env('MAIL_USERNAME');
  const pass = env('MAIL_PASSWORD');
  if (user !== undefined && pass !== undefined) options.auth = { user, pass };
  return options;
}
