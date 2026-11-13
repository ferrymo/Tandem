import pg from 'pg';
import { DomainError } from '@tandem/core';
import type { Job, JobQueue, ResourceScope } from '@tandem/core';
export * from './collaboration';
export * from './capabilities';
export * from './projects';
export const SCHEMA_VERSION = '0008_deployment_write_scope.sql';
export function createPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: 'tandem',
  });
}
export async function withScope<T>(
  pool: pg.Pool,
  scope: ResourceScope,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      [scope.workspaceId, scope.actorId],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function databaseReady(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query(
    'SELECT version FROM tandem.schema_migrations ORDER BY version DESC LIMIT 1',
  );
  if (result.rows[0]?.version !== SCHEMA_VERSION) return false;
  const ext = await pool.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
  );
  return ext.rowCount === 1;
}
const leasePredicate =
  "id = $1 AND execution_token = $2 AND leased_by = $3 AND status = 'running' AND lease_until > clock_timestamp()";
export class PostgresJobQueue implements JobQueue {
  constructor(private readonly pool: pg.Pool) {}
  async enqueue(
    client: pg.PoolClient,
    input: {
      workspaceId: string;
      kind: string;
      reference: string;
      dedupeKey: string;
      maxAttempts?: number;
    },
  ): Promise<string> {
    const result = await client.query(
      `INSERT INTO tandem.jobs (workspace_id, kind, reference, dedupe_key, max_attempts)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
      WHERE tandem.jobs.kind = EXCLUDED.kind AND tandem.jobs.reference = EXCLUDED.reference AND tandem.jobs.max_attempts = EXCLUDED.max_attempts RETURNING id`,
      [
        input.workspaceId,
        input.kind,
        input.reference,
        input.dedupeKey,
        input.maxAttempts ?? 3,
      ],
    );
    if (!result.rows[0])
      throw new DomainError('CONFLICT', '去重键已用于不同任务');
    return result.rows[0].id;
  }
  async claim(workerId: string, leaseMs: number): Promise<Job | null> {
    await this.pool
      .query(`UPDATE tandem.jobs SET status = 'failed', error_code = 'LEASE_ATTEMPTS_EXHAUSTED', leased_by = NULL, lease_until = NULL
      WHERE status = 'running' AND lease_until <= clock_timestamp() AND attempts >= max_attempts`);
    const result = await this.pool.query(
      `WITH candidate AS (
      SELECT id FROM tandem.jobs WHERE attempts < max_attempts AND
        ((status = 'queued' AND available_at <= clock_timestamp()) OR (status = 'running' AND lease_until <= clock_timestamp()))
      ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE tandem.jobs j SET status = 'running', leased_by = $1, lease_until = clock_timestamp() + $2 * interval '1 millisecond',
      execution_token = execution_token + 1, attempts = attempts + 1
      FROM candidate c WHERE j.id = c.id RETURNING j.*`,
      [workerId, leaseMs],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          kind: row.kind,
          reference: row.reference,
          token: row.execution_token,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          checkpoint: row.checkpoint,
        }
      : null;
  }
  async renew(job: Job, workerId: string, leaseMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tandem.jobs SET lease_until = clock_timestamp() + $4 * interval '1 millisecond' WHERE ${leasePredicate}`,
      [job.id, job.token, workerId, leaseMs],
    );
    return r.rowCount === 1;
  }
  async complete(job: Job, workerId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tandem.jobs SET status = 'completed', completed_at = clock_timestamp(), lease_until = NULL, leased_by = NULL WHERE ${leasePredicate}`,
      [job.id, job.token, workerId],
    );
    return r.rowCount === 1;
  }
  async fail(job: Job, workerId: string, code: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tandem.jobs SET status = 'failed', error_code = $4, lease_until = NULL, leased_by = NULL WHERE ${leasePredicate}`,
      [job.id, job.token, workerId, code],
    );
    return r.rowCount === 1;
  }
  async checkpoint(
    job: Job,
    workerId: string,
    value: Record<string, unknown>,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tandem.jobs SET checkpoint = $4::jsonb WHERE ${leasePredicate}`,
      [job.id, job.token, workerId, JSON.stringify(value)],
    );
    return r.rowCount === 1;
  }
}
export async function heartbeat(
  pool: pg.Pool,
  workerId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO tandem.worker_heartbeats (worker_id, seen_at) VALUES ($1, clock_timestamp())
    ON CONFLICT (worker_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
    [workerId],
  );
}
export * from './delivery';
