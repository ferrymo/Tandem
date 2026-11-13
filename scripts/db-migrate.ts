import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_MIGRATION_URL)
  throw new Error('缺少 DATABASE_MIGRATION_URL');
const client = new pg.Client({
  connectionString: process.env.DATABASE_MIGRATION_URL,
});
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(72618102)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS tandem.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  await client.query(
    'GRANT SELECT ON tandem.schema_migrations TO tandem_app, tandem_worker',
  );
  const dir = new URL(
    '../packages/storage-postgres/migrations/',
    import.meta.url,
  );
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+_.+\.sql$/.test(n))
    .sort()) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM tandem.schema_migrations WHERE version=$1',
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== hash)
        throw new Error('已执行迁移被修改：' + name);
      console.log('已应用 ' + name);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO tandem.schema_migrations (version, checksum) VALUES ($1,$2)',
        [name, hash],
      );
      await client.query('COMMIT');
      console.log('已迁移 ' + name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(72618102)');
  await client.end();
}
