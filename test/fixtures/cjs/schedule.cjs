// A CommonJS entry: it loads the CommonJS build, and the command (ES
// modules) still sees its tasks.
const { schedule } = require('../../../dist/cjs/index.js');

schedule('from-commonjs', '* * * * *', () => {});
