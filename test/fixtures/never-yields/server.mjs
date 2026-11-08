// An app with jobs that never stop on their own: one holds the event loop,
// one yields but ignores its abort signal. The bridge's watchdog kills the
// process before the batch is answered.
import { createServer } from 'node:http';

import { defineJob } from '../../../dist/esm/index.js';
import { withBridge } from '../../../dist/esm/http.js';

defineJob('finishes', () => {
  process.stdout.write('finishes ran\n');
});
defineJob('spins', () => {
  for (;;);
});

defineJob('ignores-abort', () => new Promise((resolve) => setTimeout(resolve, 60_000)));

const server = createServer(withBridge((_req, res) => res.end('app')));
server.listen(0, '127.0.0.1', () => process.stdout.write(`port ${server.address().port}\n`));
