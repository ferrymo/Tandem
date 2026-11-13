import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const folder = 'data/backups';
mkdirSync(folder, { recursive: true });
const name =
  'tandem-' + new Date().toISOString().replaceAll(':', '-') + '.dump';
const result = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'tandem',
    '-Fc',
    '-f',
    '/tmp/' + name,
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(1);
const copy = spawnSync(
  'docker',
  ['compose', 'cp', 'postgres:/tmp/' + name, folder + '/' + name],
  { stdio: 'inherit' },
);
if (copy.status !== 0) process.exit(1);
console.log('备份：' + folder + '/' + name + '；产物目录需单独备份。');
