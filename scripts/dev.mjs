import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { runtimeEnv } from './runtime-env.mjs';
loadEnvFile(resolve(import.meta.dirname, '../.env'));
const root = resolve(import.meta.dirname, '..');
const children = [
  spawn(
    process.execPath,
    [
      resolve(root, 'apps/web/node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3000',
    ],
    {
      cwd: resolve(root, 'apps/web'),
      stdio: 'inherit',
      env: {
        ...runtimeEnv('web'),
        TANDEM_ATTACHMENT_ROOT: resolve(
          root,
          process.env.TANDEM_ATTACHMENT_ROOT ?? 'data/attachments',
        ),
      },
      windowsHide: true,
    },
  ),
  spawn(
    process.execPath,
    ['--import', 'tsx', resolve(root, 'apps/worker/src/index.ts')],
    {
      cwd: root,
      stdio: 'inherit',
      env: runtimeEnv('worker'),
      windowsHide: true,
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 12000).unref();
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
