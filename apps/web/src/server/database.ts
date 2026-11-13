import { createPool, databaseReady } from '@tandem/storage-postgres';
import { createLogger, readWebEnv, safeErrorCode } from '@tandem/platform';
const globalDb = globalThis as typeof globalThis & {
  tandemPool?: ReturnType<typeof createPool>;
};
export const checkDatabase = () => databaseReady(database());
export function database() {
  if (!globalDb.tandemPool) {
    const env = readWebEnv();
    const logger = createLogger('web', env.LOG_LEVEL);
    globalDb.tandemPool = createPool(env.DATABASE_URL);
    globalDb.tandemPool.on('error', (error) =>
      logger.error({ code: safeErrorCode(error) }, '数据库空闲连接异常'),
    );
  }
  return globalDb.tandemPool;
}
