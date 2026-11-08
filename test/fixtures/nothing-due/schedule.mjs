// A schedule with nothing due in most minutes.
import { schedule } from '../../../dist/esm/index.js';

schedule('new-year', '0 0 1 1 *', () => {}, { timeZone: 'UTC' });
