import { randomBytes } from 'node:crypto';
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const env = resolve(root, '.env');
if (existsSync(env)) {
  console.log('.env 已存在，保留现有配置。');
} else {
  const passwords = Array.from({ length: 4 }, () =>
    randomBytes(24).toString('hex'),
  );
  const [admin, migration, app, worker] = passwords;
  writeFileSync(
    env,
    [
      'NODE_ENV=development',
      'PORT=3000',
      'POSTGRES_PORT=55432',
      'POSTGRES_DB=tandem',
      'POSTGRES_PASSWORD=' + admin,
      'MIGRATION_PASSWORD=' + migration,
      'APP_PASSWORD=' + app,
      'WORKER_PASSWORD=' + worker,
      'DATABASE_ADMIN_URL=postgresql://postgres:' +
        admin +
        '@127.0.0.1:55432/tandem',
      'DATABASE_MIGRATION_URL=postgresql://tandem_migrator:' +
        migration +
        '@127.0.0.1:55432/tandem',
      'DATABASE_URL=postgresql://tandem_app:' + app + '@127.0.0.1:55432/tandem',
      'WORKER_DATABASE_URL=postgresql://tandem_worker:' +
        worker +
        '@127.0.0.1:55432/tandem',
      'WORKER_POLL_MS=1000',
      'WORKER_LEASE_MS=30000',
      'WORKER_SHUTDOWN_MS=10000',
      'LOG_LEVEL=info',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('已生成 .env（随机本地密码，不输出凭证）。');
}
// Add the new key without replacing existing database or deployment settings.
if (!/^SESSION_ENCRYPTION_KEY=.+$/m.test(readFileSync(env, 'utf8'))) {
  if (/^SESSION_ENCRYPTION_KEY=/m.test(readFileSync(env, 'utf8'))) {
    const content = readFileSync(env, 'utf8').replace(
      /^SESSION_ENCRYPTION_KEY=.*$/m,
      'SESSION_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    );
    writeFileSync(env, content, { mode: 0o600 });
  } else {
    appendFileSync(
      env,
      '\nSESSION_ENCRYPTION_KEY=' + randomBytes(32).toString('hex') + '\n',
      { mode: 0o600 },
    );
  }
  console.log('已生成本地会话加密密钥（不输出密钥）。');
}
mkdirSync(resolve(root, 'data/artifacts'), { recursive: true });
mkdirSync(resolve(root, 'data/backups'), { recursive: true });
console.log('本地配置就绪；继续执行 db:up、db:bootstrap、db:migrate。');
