import {
  createPool,
  databaseReady,
} from '../packages/storage-postgres/src/index.js';
if (!process.env.DATABASE_URL || !process.env.WORKER_DATABASE_URL)
  throw new Error('请先执行 local:init');
for (const url of [process.env.DATABASE_URL, process.env.WORKER_DATABASE_URL]) {
  const pool = createPool(url);
  try {
    if (!(await databaseReady(pool))) throw new Error('Schema/pgvector 未就绪');
    const role = await pool.query(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    if (role.rows[0].rolsuper || role.rows[0].rolbypassrls)
      throw new Error('应用账号权限过高');
    console.log(role.rows[0].rolname + ': schema、pgvector、最小账号检查通过');
  } finally {
    await pool.end();
  }
}
