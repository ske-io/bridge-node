// Builds the package twice from src/: ES modules into dist/esm and CommonJS
// into dist/cjs, each with its type declarations. dist/cjs gets a
// package.json saying so, since the package itself is "type": "module".
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const tsc = (project) => execFileSync('tsc', ['-p', project], { stdio: 'inherit', env: { ...process.env, PATH: `node_modules/.bin:${process.env.PATH}` } });
tsc('tsconfig.json');
tsc('tsconfig.cjs.json');
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
// The command-line tool is ES modules only: it imports the app's entry,
// which may be either kind.
rmSync('dist/cjs/cli.js');
rmSync('dist/cjs/cli.d.ts');
chmodSync('dist/esm/cli.js', 0o755);
