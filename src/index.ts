/**
 * Runs a Node application on SKE.
 *
 * The integrations (`@ske-io/bridge/express`, `/fastify`, `/koa`, `/hono`,
 * `/http`, `/nest`) answer the platform's internal routes inside the
 * application, apply maintenance mode, trust the one proxy hop in front of
 * the app and write logs as the platform reads them. This module holds what
 * every app shares: jobs, scheduled tasks, the logger and the mail
 * transport.
 *
 * Everything is inert off the platform, so the package is safe to install
 * unconditionally.
 */

export { env, onPlatform } from './env.js';
export { client, type Client } from './forwarded.js';
export { createLogger, logger, withRequestId, type Logger, type LogContext } from './logging.js';
export { mailTransport, type SmtpOptions } from './mail.js';
export { maintenanceActive } from './maintenance.js';
export { defineJob, dispatch, type DispatchOptions, type Job, type JobContext, type JobHandler } from './queue/jobs.js';
export { schedule, type ScheduleOptions } from './schedule/schedule.js';
export type { BridgeOptions } from './request.js';
