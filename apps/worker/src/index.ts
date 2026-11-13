import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { executeJob } from '@tandem/agent-runtime';
import { createLogger, readWorkerEnv, safeErrorCode } from '@tandem/platform';
import {
  createPool,
  databaseReady,
  heartbeat,
  PostgresJobQueue,
} from '@tandem/storage-postgres';
const env = readWorkerEnv();
const logger = createLogger('worker', env.LOG_LEVEL);
const pool = createPool(env.WORKER_DATABASE_URL);
pool.on('error', (error) =>
  logger.error({ code: safeErrorCode(error) }, '数据库空闲连接异常'),
);
const queue = new PostgresJobQueue(pool);
const workerId = randomUUID();
const shutdown = new AbortController();
let active: AbortController | undefined;
let deadline: NodeJS.Timeout | undefined;
function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  deadline = setTimeout(() => {
    active?.abort();
    logger.warn('关闭宽限时间已到；未完成任务由租约机制接管');
    setTimeout(() => process.exit(1), 1000).unref();
  }, env.WORKER_SHUTDOWN_MS);
  deadline.unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (!(await databaseReady(pool))) throw new Error('SCHEMA_NOT_READY');
  if (process.env.WORKER_HEALTH_FILE)
    writeFileSync(process.env.WORKER_HEALTH_FILE, workerId, { mode: 0o600 });
  logger.info({ workerId }, 'Worker 已启动，无 HTTP 监听');
  while (!shutdown.signal.aborted) {
    try {
      await heartbeat(pool, workerId);
      const job = await queue.claim(workerId, env.WORKER_LEASE_MS);
      if (!job) {
        await sleep(env.WORKER_POLL_MS, undefined, {
          signal: shutdown.signal,
        }).catch(() => undefined);
        continue;
      }
      const controller = new AbortController();
      active = controller;
      // Serialize renewals; a lost lease aborts the handler and prevents final writes.
      let renewing = false;
      const timer = setInterval(
        () => {
          if (renewing || controller.signal.aborted) return;
          renewing = true;
          void Promise.all([
            queue.renew(job, workerId, env.WORKER_LEASE_MS),
            heartbeat(pool, workerId),
          ])
            .then(([valid]) => {
              if (!valid) controller.abort();
            })
            .catch(() => controller.abort())
            .finally(() => {
              renewing = false;
            });
        },
        Math.floor(env.WORKER_LEASE_MS / 3),
      );
      try {
        await executeJob(
          queue,
          job,
          workerId,
          new Map([
            [
              'system.diagnostic',
              async () => {
                if (
                  !(await queue.checkpoint(job, workerId, { verified: true }))
                )
                  controller.abort();
              },
            ],
          ]),
          controller.signal,
        );
        logger.info(
          {
            jobId: job.id,
            attempt: job.attempts,
            interrupted: controller.signal.aborted,
          },
          '后台任务处理结束',
        );
      } finally {
        clearInterval(timer);
        active = undefined;
      }
    } catch (error) {
      logger.error({ code: safeErrorCode(error) }, 'Worker 暂时不可用');
      await sleep(env.WORKER_POLL_MS, undefined, {
        signal: shutdown.signal,
      }).catch(() => undefined);
    }
  }
} catch (error) {
  logger.error(
    { code: safeErrorCode(error) },
    'Worker 启动失败；检查配置和数据库迁移',
  );
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  await pool
    .query('DELETE FROM tandem.worker_heartbeats WHERE worker_id=$1', [
      workerId,
    ])
    .catch(() => undefined);
  await pool.end();
  logger.info('Worker 已停止');
}
