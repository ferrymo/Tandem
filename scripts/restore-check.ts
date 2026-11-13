import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  createPool,
  databaseReady,
} from '../packages/storage-postgres/src/index.js';
if (!process.env.DATABASE_ADMIN_URL || !process.env.DATABASE_URL)
  throw new Error('缺少数据库配置');
const backup = readdirSync('data/backups')
  .filter((n) => /^tandem-[\w.-]+\.dump$/.test(n))
  .sort()
  .at(-1);
if (!backup) throw new Error('请先执行 db:backup');
const name = 'tandem_restore_' + randomUUID().replaceAll('-', '');
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
const run = (args: string[]) => {
  const r = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error('恢复命令失败');
};
const applicationUrl = new URL(process.env.DATABASE_URL);
applicationUrl.pathname = '/' + name;
const restored = createPool(applicationUrl.toString());
try {
  await admin.query('CREATE DATABASE ' + name);
  run([
    'compose',
    'cp',
    resolve('data/backups', backup),
    'postgres:/tmp/' + backup,
  ]);
  run([
    'compose',
    'exec',
    '-T',
    'postgres',
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    name,
    '--exit-on-error',
    '/tmp/' + backup,
  ]);
  assert.equal(await databaseReady(restored), true);
  assert.equal(
    (await restored.query('SELECT * FROM tandem.workspaces')).rowCount,
    0,
  );
  console.log(
    '备份恢复演练通过：新建隔离数据库、恢复 schema/扩展/角色授权、验证应用账号及无上下文 RLS。原库未覆盖。',
  );
} finally {
  await restored.end();
  if (/^tandem_restore_[a-f0-9]{32}$/.test(name))
    await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
  await admin.end();
}
