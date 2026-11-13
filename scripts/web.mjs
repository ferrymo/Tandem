import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runtimeEnv } from './runtime-env.mjs';
const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'dev';
const dev = mode === 'dev';
const child = spawn(
  process.execPath,
  dev
    ? [
        resolve(root, 'apps/web/node_modules/next/dist/bin/next'),
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        process.env.PORT ?? '3000',
      ]
    : [resolve(root, 'apps/web/.next/standalone/apps/web/server.js')],
  {
    cwd: dev ? resolve(root, 'apps/web') : root,
    stdio: 'inherit',
    env: {
      ...runtimeEnv('web'),
      HOSTNAME: process.env.TANDEM_HOST ?? '127.0.0.1',
    },
    windowsHide: true,
  },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
