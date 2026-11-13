import pg from 'pg';
import { z } from 'zod';
const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().url(),
    MIGRATION_PASSWORD: z.string().min(24),
    APP_PASSWORD: z.string().min(24),
    WORKER_PASSWORD: z.string().min(24),
  })
  .parse(process.env);
const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(72618101)');
  for (const [role, password] of [
    ['tandem_migrator', env.MIGRATION_PASSWORD],
    ['tandem_app', env.APP_PASSWORD],
    ['tandem_worker', env.WORKER_PASSWORD],
  ]) {
    const found = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname=$1',
      [role],
    );
    if (!found.rowCount)
      await client.query(
        'CREATE ROLE ' +
          role +
          ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ' +
          literal(password!),
      );
  }
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query(
    'CREATE SCHEMA IF NOT EXISTS tandem AUTHORIZATION tandem_migrator',
  );
  await client.query(
    'GRANT USAGE ON SCHEMA tandem TO tandem_app, tandem_worker',
  );
  await client.query('COMMIT');
  console.log('数据库角色、schema 与 pgvector 已就绪；已有账号密码保持不变。');
} catch {
  await client.query('ROLLBACK');
  throw new Error('数据库初始化失败，请检查管理连接与扩展支持（凭证未输出）');
} finally {
  await client.end();
}
