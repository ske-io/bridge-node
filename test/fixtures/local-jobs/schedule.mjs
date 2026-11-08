// A schedule entry that dispatches jobs. Off the platform they run in this
// process, after the entry has returned.
import { defineJob, dispatch, schedule } from '../../../dist/esm/index.js';

defineJob('child', (payload) => {
  process.stdout.write(`child ran ${payload.n}\n`);
});
defineJob('parent', async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.stdout.write('parent ran\n');
  await dispatch('child', { n: 1 });
});
defineJob('broken', () => {
  throw new Error('the job broke');
});

schedule('dispatches', '* * * * *', async () => {
  await dispatch('parent', {});
  if (process.env.FAIL_JOB === '1') await dispatch('broken', {});
  if (process.env.DELAYED_JOB === '1') await dispatch('child', { n: 2 }, { delay: 1 });
  if (process.env.LATE_JOB === '1') await dispatch('child', { n: 3 }, { delay: 900 });
});
