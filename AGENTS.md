# SKE Node bridge

npm package (`@ske-io/bridge`, bin `ske-bridge`) installed in Node apps. It answers the platform's `/__ske/health` and `/__ske/queue` routes, runs delivered jobs (`defineJob`/`dispatch`, sent to SQS on the platform), and runs the scheduled tasks due each minute as `ske-bridge schedule`. It also trusts the one proxy hop, applies maintenance mode, writes JSON logs to stderr and exposes the mail catcher as SMTP options. It supports Node 22.12+ (22, 24 and 26 tested), Express, Fastify, Koa, Hono, plain `http` and NestJS; the frameworks are optional peers, imported only by the entry point that needs them. The only runtime dependency is `@aws-sdk/client-sqs`, loaded on the first dispatch.

Layout (`src/`): the framework-agnostic core is `request.ts` (one request: internal routes, maintenance, request id), `routes.ts`, `maintenance.ts`, `forwarded.ts`, `logging.ts`, `mail.ts`, `env.ts`, `queue/` (job body, dispatch and SQS, the batch runner and its outcomes) and `schedule/` (cron parsing and due-ness, `schedule()`, one tick). `express.ts`, `fastify.ts`, `koa.ts`, `hono.ts`, `http.ts` and `nest.ts` adapt it to each framework; `cli.ts` is the bin. Process-wide state (jobs, tasks, the request context) lives on `globalThis` in `state.ts`, so the ES module and CommonJS builds loaded in one process share it.

Tests (`test/`) use `node:test` and run against the built package (`dist/`) through its own name, compiled by `tsc` into `build/test` (decorators for the Nest fixtures, and Node builds without TypeScript support). `conformance.ts` is the suite every web integration passes. Fixtures for `ske-bridge schedule` are in `test/fixtures`.

## Check

Done means `bun run check` passes: type check, both builds, then the tests on the Node on the PATH. Run the tests on every supported Node too: the declared minimum exactly (`engines` in package.json, now 22.12.0) and the newest 22, 24 and 26, each with its binary first on the PATH: `PATH=/path/to/node-v22.12.0/bin:$PATH bun run test`. CI runs the same four (`.github/workflows/tests.yml`); `test/packaging.test.ts` fails if its matrix lacks the `engines` minimum.

Dependencies: bun (`bun install`, `bun.lock`). Commit subjects are plain sentences.

## Releasing

Published on npm as `@ske-io/bridge` by `.github/workflows/publish.yml` through trusted publishing (no token), from the `npm` environment, with provenance: a published GitHub release publishes, a manual run only builds and packs. The version comes from the release tag: `package.json` keeps the placeholder `0.0.0-development` (never bump it) and the workflow sets `X.Y.Z` from the tag before building, so to release, run `gh release create vX.Y.Z --target 0.1.x --generate-notes` on the commit to ship; the workflow stops if the packed tarball is not exactly `X.Y.Z`. A manual run packs the placeholder version. npm never takes a version twice: deprecate a bad release and ship a new version.
