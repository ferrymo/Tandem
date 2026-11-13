import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runtimeEnv } from './runtime-env.mjs';
const root = resolve(import.meta.dirname, '..');
const dev = process.argv[2] === 'dev';
const child = spawn(
  process.execPath,
  dev
    ? ['--import', 'tsx', 'apps/worker/src/index.ts']
    : ['apps/worker/dist/index.js'],
  { cwd: root, env: runtimeEnv('worker'), stdio: 'inherit', windowsHide: true },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
