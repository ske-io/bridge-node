# @ske-io/bridge

Runs a Node application on SKE: it answers the platform's internal routes inside the application, runs the background jobs the platform delivers, and runs the scheduled tasks due each minute when the platform asks.

Everything is inert off the platform (when neither `SKE_PROJECT_TYPE` nor `SKE_ENVIRONMENT` is set), so the package is safe to install unconditionally.

## Install

```bash
npm install @ske-io/bridge
```

Node 22.12 or later (22, 24 and 26 are tested). The package ships ES modules and CommonJS, with TypeScript types. It needs none of the frameworks below; each integration is its own entry point and loads only its framework.

## Express

```js
import express from 'express';
import { bridge } from '@ske-io/bridge/express';

const app = express();
bridge(app); // first, before any other middleware or route

app.listen(process.env.PORT ?? 3000);
```

On the platform `bridge()` sets `trust proxy` to the one proxy hop the platform puts in front of your app, so `req.ip`, `req.protocol` and `req.hostname` are the client's (see [Client address and scheme](#client-address-and-scheme)), and adds the bridge's middleware, which answers the internal routes and maintenance mode before anything you add after it: authentication, CSRF protection and host checks never see the platform's requests. Call it before your other middleware; what you add before it runs first.

## Fastify

```js
import Fastify from 'fastify';
import { bridge } from '@ske-io/bridge/fastify';

const app = Fastify();
await app.register(bridge); // before your own plugins and hooks

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
```

On the platform the plugin adds an `onRequest` hook to the root instance that answers the internal routes and maintenance mode before routing and your hooks, and sets `request.ip`, `request.protocol`, `request.host`, `request.hostname` and `request.port` from the one trusted hop, whatever your `trustProxy` option says.

## Koa

```js
import Koa from 'koa';
import { bridge } from '@ske-io/bridge/koa';

const app = new Koa();
bridge(app); // first, before any other middleware

app.listen(process.env.PORT ?? 3000);
```

On the platform `bridge()` sets `app.proxy` with `app.proxyIpHeader = 'X-Forwarded-For'` and `app.maxIpsCount = 1`, replacing any proxy header your app chose, so `ctx.ip`, `ctx.protocol` and `ctx.host` are the client's, and adds the bridge's middleware in front of yours.

## Hono

```js
import { Hono } from 'hono';
import { bridge, client } from '@ske-io/bridge/hono';

const app = new Hono();
app.use(bridge()); // first, before any other middleware or route

app.get('/', (c) => c.text(`Hello ${client(c)?.address ?? 'there'}`));
```

Hono has no proxy setting of its own, so `client(c)` gives the client's address, scheme, host and port as the platform forwarded them; off the platform it is `undefined`.

## Node's `http` module, and other frameworks

```js
import { createServer } from 'node:http';
import { client, withBridge } from '@ske-io/bridge/http';

createServer(
  withBridge((req, res) => {
    res.end(`Hello ${client(req)?.address}`);
  }),
).listen(process.env.PORT ?? 3000);
```

`withBridge()` wraps any `(req, res)` handler, so it fits any framework that gives you one. Off the platform it returns your handler unchanged.

## NestJS

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SkeModule } from '@ske-io/bridge/nest';

@Module({
  imports: [SkeModule.forRoot(), ScheduleModule.forRoot()],
})
export class AppModule {}
```

With Nest's Express or Fastify adapter, `SkeModule` installs the bridge on the HTTP server while Nest creates the application, before anything your `main.ts` adds with `app.use()`. On the platform Nest's logger writes the platform's log records. Log levels given to `NestFactory.create()` (`logger: ['error', 'warn']`) choose which records are written, still in that format. `logger: false`, or a logger of your own (a `SkeLogger` you configured included), is kept as it is; `SKE_LOG_FORMAT=plain` leaves Nest's logger alone too. Pass `logger: new SkeLogger()` to have Nest's start-up lines in the platform's format as well, or `new SkeLogger({ levels: ['warn', 'error', 'fatal'] })` to keep only some levels.

`SkeModule` is global: `JobDispatcher` can be injected anywhere, and `@Job()` methods on any provider handle jobs (see [Jobs](#jobs)). `@nestjs/schedule` is optional; see [Schedule](#schedule) for what becomes of its `@Cron`, `@Interval` and `@Timeout` methods.

Options, for every integration: `maintenancePage`, a file or a function rendering your maintenance page (see [Maintenance mode](#maintenance-mode)).

## The platform's routes

Requests for `/__ske/*` are answered by the bridge and never reach your app:

- `GET /__ske/health` answers `200 {"status":"ok"}`. It is the readiness check the platform probes before it sends traffic to a new instance, and it is the one route here that outside traffic may reach, so a load balancer can use it too.
- `POST /__ske/queue` runs the jobs the platform delivers (see [Jobs](#jobs)). It answers only requests that carry the platform's internal header, which the platform strips from every outside request; anything else gets 404.

Commands and scheduled runs are processes the platform starts in the container; neither has a route.

## Client address and scheme

Your app listens behind the container's entry process, so every connection it sees comes from `127.0.0.1`. The platform forwards each request with:

- `X-Forwarded-For`: the chain the client sent, with the address the platform saw the request come from appended last. Only that last entry is trusted, so a client can't choose its own address by sending the header.
- `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`: replaced on every request with the scheme, host and port the client connected with.
- `Forwarded`, `X-Real-IP` and `X-Forwarded-Prefix`: removed.

The bridge trusts exactly that one hop, and only on the platform; off it, nothing is changed, because the same headers would be whatever a client sent. If a CDN sits in front of your app, the last entry is the CDN's address, and reading the client from it is your app's own trusted-proxy configuration, as it would be behind any other proxy.

`client(req)` (from `@ske-io/bridge`, or any integration's entry point) returns `{ address, protocol, host, hostname, port }` for a request the bridge handled on the platform, whatever the framework.

## Maintenance mode

Turn maintenance mode on for an environment in the SKE dashboard. The platform redeploys it with `MAINTENANCE_MODE=true`, and every web request is answered `503 Service Unavailable` with your maintenance page, or a minimal page when you have none. Your page is `views/503.html`, else `public/503.html`, from the app's working directory, or what the `maintenancePage` option names:

```js
bridge(app, { maintenancePage: 'resources/maintenance.html' });
bridge(app, { maintenancePage: (req) => renderMaintenancePage(req) });
```

The readiness check, queued jobs and commands keep working, and so do requests the platform sends with its internal header, such as warmup requests. Visitors from the environment's access list are let in too: the platform marks their requests with a header carrying a token only it and your app know. Scheduled tasks are skipped, except those marked to run anyway (see [Schedule](#schedule)).

Set `MAINTENANCE_MODE_SECRET` to look at the site while it's down: visiting `https://your-site/<secret>` sets a cookie and redirects to `/`, and that browser is let in for 12 hours. The cookie, `ske_maintenance`, is HTTP-only, `SameSite=Lax`, `Secure` over HTTPS, and signed with the secret, so changing the secret ends every one handed out. Maintenance responses are not cached.

## Logs

On the platform every log record is one JSON line on stderr, which the logs page reads into level, message, context and exception:

```json
{"message":"Payment failed","level_name":"ERROR","context":{"order":7,"request_id":"…","exception":{"class":"PaymentError","message":"…","file":"/var/task/dist/pay.js:12","trace":["/var/task/dist/orders.js:40"],"previous":{"class":"RangeError","message":"card expired","file":"…","trace":[]}}},"channel":"app","datetime":"2026-10-28T09:30:00.123+00:00","extra":{}}
```

Once an integration is installed, `console.log`, `info`, `debug`, `trace`, `warn` and `error` write in this format, at INFO, INFO, DEBUG, DEBUG, WARNING and ERROR. The first `Error` among a call's arguments becomes the record's `exception`, with its trace and its `cause` as `previous`; the other arguments are the message, as the console would print them. A record written while a request is served carries the request's id, from the platform's `X-Request-Id` header, as `context.request_id`, including records written in callbacks and promises the request started; records written outside a request carry none.

For structured context and the other levels, use the logger:

```js
import { logger, createLogger } from '@ske-io/bridge';

logger.notice('Order placed', { order: 7 });
logger.error('Payment failed', { order: 7, exception: error });

const billing = createLogger('billing'); // the record's channel
billing.critical('Billing is down');
```

Levels are `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert` and `emergency`. Off the platform the logger writes readable lines to stderr. Set `SKE_LOG_FORMAT=plain` to keep the console exactly as it is on the platform too.

Loggers that write JSON of their own (pino, winston) keep their format; point them at stderr, and the logs page shows each line as its message.

## Mail

When the environment has the platform's mail service attached, the platform runs an SMTP server in the container that catches every mail your app sends, so none reaches a real inbox, and sets `MAIL_MAILER=smtp`, `MAIL_HOST` and `MAIL_PORT` to it. It speaks plain SMTP, with no TLS and no login (`MAIL_ENCRYPTION` is empty). `mailTransport()` turns this into options for nodemailer, or any client taking the same names:

```js
import nodemailer from 'nodemailer';
import { mailTransport } from '@ske-io/bridge';

const transport = nodemailer.createTransport(
  mailTransport({ host: 'smtp.example.com', port: 587, auth: { user, pass } }),
);
```

On the platform with the SMTP mailer it returns `{ host, port, secure: false, ignoreTLS: true }`, with no login, in place of your own settings: the service is attached to keep mail from going out, and your real server would let it out. With `MAIL_ENCRYPTION` set (`tls` or `ssl`), TLS and the `MAIL_USERNAME`/`MAIL_PASSWORD` login are kept. Without the service, and off the platform, it returns the options you passed, or `undefined` without any. Mail your app sends through a provider's API is left to your app.

## Jobs

```js
import { defineJob, dispatch } from '@ske-io/bridge';

const welcome = defineJob('send-welcome-mail', async (payload, job) => {
  await sendWelcomeMail(payload.userId, { signal: job.signal });
});

await dispatch('send-welcome-mail', { userId: 7 });
await welcome.dispatch({ userId: 7 }, { delay: 60 }); // the same, a minute later
```

A job is a name and a handler. Define your jobs in a module both your web server and your entry point load, so the process that receives a delivered job knows it; defining one name twice is an error. `dispatch()` resolves to the job's id once the job is queued. Options: `delay`, in whole seconds up to 900, and `queue`, the name of one of the environment's queues.

The handler gets the payload and `{ id, name, attempts, signal }`. The payload travels as JSON, so the handler always gets a JSON copy of what was dispatched: dates become strings, `undefined` fields disappear.

Where the job runs:

- **On the platform**, `dispatch()` sends the job to the environment's SQS queue: `{SQS_PREFIX}/{name}{SQS_SUFFIX}`, where the name is `queue`, else `SQS_QUEUE`, else `default`, and a name the environment doesn't list in `SQS_QUEUES` is refused. The region is `AWS_REGION`, else `AWS_DEFAULT_REGION`, and the credentials are the function's role. The AWS SDK is loaded on the first dispatch. The platform delivers the message back to your app, which runs the handler; no worker process runs.
- **Off the platform**, `dispatch()` runs the handler in your process on the next tick, after the delay, and logs an error it throws. `ske-bridge schedule` waits for the jobs its tasks dispatched before it exits (see [Schedule](#schedule)). With `SKE_QUEUE_SYNC=1` it runs the handler before `dispatch()` resolves, and an error it throws rejects `dispatch()`, which is what tests want.

The message body is `{"job":"send-welcome-mail","payload":{"userId":7},"id":"<uuid>"}`; the id is made once by `dispatch()` and stays the same on every delivery, so a handler can use it to do its work only once.

What becomes of a delivered message, with the queue's `tries`, `backoff` and `timeout` settings:

| The job | The message |
|---|---|
| resolves | acknowledged |
| throws or rejects, with tries left | delivered again after `backoff` seconds |
| throws or rejects on its last try | kept in the queue's dead-letter queue |
| runs past its time limit, then stops when its `signal` is aborted | as a failure: never acknowledged, even when the handler returns |
| is still running a short grace after its time limit (it ignores its `signal`, or holds the event loop) | the process is stopped; the whole batch is delivered again |
| was not started, or was stopped, because the batch ran out of time | delivered again, with no try used up |
| names a job this app doesn't define, or isn't a job message | kept in the dead-letter queue |
| has been delivered more times than `tries` allows | kept in the dead-letter queue, without running |

`tries` counts every delivery: with `tries: 3` a job runs at most three times. Each job may run for the queue's `timeout` less a margin for reporting back (5 seconds, or half the timeout when that is less), and never past the time the platform gives the whole batch, counted from when the batch arrives: a job stopped by the batch's time rather than its own is delivered again with no try used up. JavaScript can't stop a function from outside, so a handler that runs out of time is told through `job.signal`; pass it to `fetch` and other calls that take one, or check `signal.aborted` between steps, and stop. The handler then has a short grace (a second at most, always before the platform's own timeout) to finish; the batch is answered only once it has, so a job that's released never keeps running beside its own redelivery. A handler that holds the process (CPU-bound work, a long synchronous call) can't be told at all; if it returns late, its time is checked and it counts as out of time, never done. A handler still running when the grace ends, because it ignores its signal or never gives the event loop back, is stopped with the process: a watchdog thread outside your app's event loop kills it, after writing a CRITICAL log line naming the job. Nothing of the batch has been answered, so nothing in it is acknowledged; the platform counts the invocation as failed, delivers the batch's messages again and starts a fresh instance. That includes the batch's jobs that had already finished: they run again, as any job can, since delivery is at least once (the platform settles a batch only from its answer). Keep queues whose jobs can be CPU-bound at the default batch size of 1. Honour the signal, and keep CPU-heavy work short or split it across jobs. The watchdog takes none of your app's Node flags; if it can't start at all (a permission model that refuses worker threads, say), that is logged as an error once and jobs keep only the time limit they honour themselves.

The jobs of a batch run one after another, each within the batch's time, so a larger batch size gives later jobs less time, and those not started in time are delivered again. A job may run more than once (a redelivery after a crash, a release, a stopped process), so a job whose effects must happen once checks its `id` before acting.

The package keeps no record of failed jobs, so every failure is kept in the queue's dead-letter queue, where you can inspect it and send it again.

### Jobs in NestJS

```ts
import { Injectable } from '@nestjs/common';
import { Job, JobDispatcher } from '@ske-io/bridge/nest';

@Injectable()
export class Mailer {
  @Job('send-welcome-mail')
  async welcome(payload: { userId: number }) {
    // ...
  }
}

@Injectable()
export class Signup {
  constructor(private readonly jobs: JobDispatcher) {}

  register(userId: number) {
    return this.jobs.dispatch('send-welcome-mail', { userId });
  }
}
```

A `@Job()` method is defined when the application starts, and runs on its provider, with everything injected into it.

## Schedule

```js
// src/schedule.js
import { dispatch, schedule } from '@ske-io/bridge';
import './jobs.js'; // the jobs the tasks dispatch

schedule('prune-sessions', '0 3 * * *', async () => {
  await pruneSessions();
}, { timeZone: 'Europe/Paris' });

schedule('send-digest', '*/15 * * * *', () => dispatch('send-digest', {}));
```

```json
{ "ske": { "schedule": "src/schedule.js" } }
```

No timer runs in your app. Once a minute the platform runs `ske-bridge schedule`, which loads your schedule entry, runs the tasks due in that minute one after the other, waits for each to finish, and exits; it exits non-zero when any due task failed, and a failing task doesn't stop the others. The entry is a module that adds tasks with `schedule()` when it is loaded, and starts no server; name it in `package.json` as `"ske": {"schedule": "…"}`, or on the command line, `ske-bridge schedule dist/schedule.js`. Without one, the command does nothing.

A task that dispatches jobs only queues them on the platform, where the queue runs them. Run off the platform (`npx ske-bridge schedule` on your machine), those jobs run in the command's own process, so it waits for them, and for the jobs they dispatch in turn, before it exits: at most 60 seconds. A job that fails, finishes after the wait ends, or would start after it (a long `delay`) fails the run, named in the log. The wait can't interrupt a job: one that holds the process (CPU-bound work) finishes when it finishes and is then reported late, and one that never yields keeps the command running until you stop it. Only the platform's queue stops such a job (see [Jobs](#jobs)).

A task's expression has five fields (minute, hour, day of month, month, day of week) or six with seconds first. Fields take `*`, numbers, ranges (`1-5`), steps (`*/15`) and lists, and month and day names (`jan`, `mon-fri`); `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` and the like work too. When both day fields are set, a day matching either is due, as in classic cron. `schedule()` checks the expression and the time zone when your entry loads, so a mistake fails the run rather than skip the task silently.

Due is decided from the minute alone, in the task's `timeZone` (your process's own time zone by default, UTC on the platform unless you set `TZ`):

- The minute is the one the platform scheduled the run for, which it passes as `SKE_SCHEDULED_AT`, so a run that starts late or is retried runs that minute's tasks; without it, the clock's.
- Daylight saving time applies in a time zone that has it. When clocks go back, the repeated hour's minutes are due twice, so `30 1 * * *` in `America/New_York` runs twice that night. When clocks go forward, the skipped hour never happens, so a task in it does not run that day. Use `UTC` to avoid both.
- The schedule cannot be finer than a minute. An expression matching more than one second of a minute (`*/30 * * * * *`) runs once a minute, with a warning naming the task.
- A tick delivered twice runs its tasks twice, so a task that must never run twice guards itself, as it would with more than one scheduler.
- Runs don't wait for each other: a task that takes longer than a minute is still running when the next minute's run starts it again. Keep tasks short; for longer work, have the task `dispatch()` a job.

While the app is in maintenance mode, tasks are skipped unless marked `{ evenInMaintenance: true }`.

### Schedule in NestJS

For a NestJS app the entry defaults to `dist/app.module.js`, the module `nest build` emits; name another with `"ske": {"schedule": "dist/other.module.js#OtherModule"}`. The command creates an application context from that module, with no HTTP server, and runs, besides any `schedule()` tasks:

- the `@Cron()` methods due this minute, named by their `name` option or as `Class.method`; `disabled` ones are left out,
- cron jobs your code adds to Nest's `SchedulerRegistry`.

A `@Cron()` method follows its job in `SchedulerRegistry`, named or not (an unnamed one is under the key Nest generated for it): a `setTime()` gives it a new expression or time zone, a deleted job doesn't run, and a job of your own put under its key runs instead of the method, without the method's `@EvenInMaintenance()`.

```ts
import { Cron } from '@nestjs/schedule';
import { EvenInMaintenance } from '@ske-io/bridge/nest';

@Injectable()
export class Reports {
  @Cron('0 9 * * 1', { name: 'weekly-report', timeZone: 'Europe/Paris' })
  async weekly() { /* ... */ }

  @Cron('*/5 * * * *')
  @EvenInMaintenance()
  async heartbeat() { /* ... */ }
}
```

On the platform `SkeModule` keeps Nest's scheduler from running timers in your app: cron jobs are stopped as Nest starts them, since the platform's scheduler runs them, and `@Interval()` and `@Timeout()` methods, which only a process that never stops could keep, are skipped with a warning naming each one; make them `@Cron()` methods. Off the platform, `nest start` runs all of them as usual.

## Commands

Commands from the CLI or the console (`node dist/migrate.js`, `npx prisma migrate deploy`) run as plain processes in the container; they need nothing from the bridge.

## Environment

Every process inherits the platform's variables in `process.env`, so there is nothing to load. Dotenv loaders (`dotenv`, `node --env-file`, `@nestjs/config`) leave a variable that is already set alone unless told to override it, so a `.env` file in the image cannot replace what the platform set; don't turn on their override option for production.
