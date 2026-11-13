import pg from 'pg';
import { readFileSync } from 'node:fs';
const id = readFileSync('/tmp/tandem-worker-id', 'utf8').trim();
const pool = new pg.Pool({
  connectionString: process.env.WORKER_DATABASE_URL,
  connectionTimeoutMillis: 3000,
  statement_timeout: 3000,
});
try {
  const result = await pool.query(
    "SELECT 1 FROM tandem.worker_heartbeats WHERE worker_id=$1 AND seen_at>now()-interval '60 seconds'",
    [id],
  );
  process.exitCode = result.rowCount === 1 ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
