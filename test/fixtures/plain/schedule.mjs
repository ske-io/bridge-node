// A plain Node app's schedule entry: it adds tasks and starts no server.
import { schedule } from '../../../dist/esm/index.js';

const noop = () => {};

schedule('every-minute', '* * * * *', noop);
schedule('hourly', '@hourly', noop);
schedule('quarter-past', '15 * * * *', noop);
schedule('paris-nine', '0 9 * * *', noop, { timeZone: 'Europe/Paris' });
schedule('new-york-0130', '30 1 * * *', noop, { timeZone: 'America/New_York' });
schedule('new-york-0230', '30 2 * * *', noop, { timeZone: 'America/New_York' });
schedule('weekday-noon', '0 12 * * mon-fri', noop, { timeZone: 'UTC' });
schedule('first-or-monday', '0 0 1 * 1', noop, { timeZone: 'UTC' });
schedule('every-thirty-seconds', '*/30 * * * * *', noop);
schedule('at-second-ten', '10 * * * * *', noop);
schedule('runs-in-maintenance', '* * * * *', noop, { evenInMaintenance: true });
schedule('slow', '* * * * *', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.stdout.write('slow finished\n');
});
schedule('fails-when-asked', '* * * * *', () => {
  if (process.env.FAIL_TASK === '1') throw new Error('the task broke');
});

// A handle the app leaves open must not keep the command running.
setInterval(noop, 1000);
