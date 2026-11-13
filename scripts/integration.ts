import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import {
  createPool,
  databaseReady,
  PostgresJobQueue,
  PostgresCollaborationRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';
if (
  !process.env.DATABASE_ADMIN_URL ||
  !process.env.DATABASE_URL ||
  !process.env.WORKER_DATABASE_URL ||
  !process.env.DATABASE_MIGRATION_URL
)
  throw new Error('请先初始化 .env');
const name = 'tandem_test_' + randomUUID().replaceAll('-', '');
const url = (input: string) => {
  const u = new URL(input);
  u.pathname = '/' + name;
  return u.toString();
};
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const env = {
  ...process.env,
  DATABASE_ADMIN_URL: url(process.env.DATABASE_ADMIN_URL),
  DATABASE_MIGRATION_URL: url(process.env.DATABASE_MIGRATION_URL),
  DATABASE_URL: url(process.env.DATABASE_URL),
  WORKER_DATABASE_URL: url(process.env.WORKER_DATABASE_URL),
};
const app = createPool(env.DATABASE_URL);
const workerPool = createPool(env.WORKER_DATABASE_URL);
const fixture = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
let child: ReturnType<typeof spawn> | undefined;
async function script(file: string) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', file], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(file + ' failed')),
    );
  });
}
async function until(fn: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error('超时：' + label);
}
try {
  await script('scripts/db-bootstrap.ts');
  await script('scripts/db-migrate.ts');
  await script('scripts/db-migrate.ts');
  await fixture.connect();
  assert.equal(await databaseReady(app), true);
  assert.equal(
    (
      await fixture.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector AS distance",
      )
    ).rows[0].distance,
    0,
  );
  const repository = new PostgresCollaborationRepository(app);
  async function ownerScope(subject: string) {
    const session = await repository.createSession({
      login: {
        providerId: 'foundation-fixture',
        subject,
        displayName: subject,
        canCreateWorkspace: true,
      },
      tokenHash: randomUUID().replaceAll('-', '').repeat(2),
      encryptedCredential: 'isolated-fixture-only',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const workspace = await repository.createWorkspace(
      session.identity.id,
      '隔离测试',
      randomUUID(),
    );
    return { workspaceId: workspace.id, actorId: session.identity.id };
  }
  const a = await ownerScope('张三');
  const b = await ownerScope('李四');
  assert.equal(
    (await app.query('SELECT * FROM tandem.workspaces')).rowCount,
    0,
  );
  assert.equal(
    (await withScope(app, a, (c) => c.query('SELECT * FROM tandem.workspaces')))
      .rowCount,
    1,
  );
  await assert.rejects(
    withScope(app, a, (c) =>
      c.query('INSERT INTO tandem.workspaces (id,name) VALUES ($1,$2)', [
        randomUUID(),
        '不允许',
      ]),
    ),
  );
  assert.equal(
    (await app.query('SELECT * FROM tandem.workspaces')).rowCount,
    0,
  );
  await assert.rejects(app.query('CREATE TABLE tandem.forbidden (id int)'));
  const roles = await app.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
  );
  assert.equal(roles.rows[0].rolsuper, false);
  assert.equal(roles.rows[0].rolbypassrls, false);
  const queue = new PostgresJobQueue(workerPool);
  const enqueue = (key: string, maxAttempts = 3) =>
    withScope(app, a, (c) =>
      queue.enqueue(c, {
        workspaceId: a.workspaceId,
        kind: 'system.diagnostic',
        reference: key,
        dedupeKey: key,
        maxAttempts,
      }),
    );
  const id = await enqueue('dedupe');
  assert.equal(await enqueue('dedupe'), id);
  await assert.rejects(enqueue('dedupe', 2), { code: 'CONFLICT' });
  assert.equal(
    (await withScope(app, b, (c) => c.query('SELECT * FROM tandem.jobs')))
      .rowCount,
    0,
  );
  const w1 = randomUUID(),
    w2 = randomUUID();
  const claims = await Promise.all([
    queue.claim(w1, 30000),
    queue.claim(w2, 30000),
  ]);
  const first = claims.find(Boolean)!;
  const owner = claims[0] ? w1 : w2;
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await queue.checkpoint(first, owner, { step: 1 }), true);
  await fixture.query(
    "UPDATE tandem.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  assert.equal(await queue.renew(first, owner, 30000), false);
  const renewed = await queue.claim(w2, 30000);
  assert.ok(renewed);
  assert.equal(renewed.id, id);
  assert.deepEqual(renewed.checkpoint, { step: 1 });
  assert.equal(BigInt(renewed.token), BigInt(first.token) + 1n);
  assert.equal(await queue.complete(first, owner), false);
  assert.equal(await queue.checkpoint(first, owner, { step: 'stale' }), false);
  assert.equal(await queue.complete(renewed, w2), true);
  const exhaustedId = await enqueue('exhausted', 1);
  assert.ok(await queue.claim(w1, 30000));
  await fixture.query(
    "UPDATE tandem.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [exhaustedId],
  );
  assert.equal(await queue.claim(w2, 30000), null);
  assert.equal(
    (
      await fixture.query('SELECT status FROM tandem.jobs WHERE id=$1', [
        exhaustedId,
      ])
    ).rows[0].status,
    'failed',
  );
  child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/worker/src/index.ts'],
    {
      env: { ...env, WORKER_POLL_MS: '100' },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  await until(
    async () =>
      (await fixture.query('SELECT * FROM tandem.worker_heartbeats'))
        .rowCount === 1,
    'Worker 心跳',
  );
  const live = await enqueue('live');
  await until(
    async () =>
      (
        await fixture.query('SELECT status FROM tandem.jobs WHERE id=$1', [
          live,
        ])
      ).rows[0].status === 'completed',
    'Worker 消费持久任务',
  );
  console.log(
    '集成通过：空库/重复迁移、pgvector、RLS/回滚隔离、DDL 拒绝、去重、并发领取、租约接管、旧令牌拒绝、重试上限、真实 Worker 消费。',
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      child!.once('exit', () => resolve()),
    );
    child.kill('SIGTERM');
    await exited;
  }
  await Promise.all([app.end(), workerPool.end(), fixture.end()]);
  // Only the database with a generated test prefix is removed.
  if (/^tandem_test_[a-f0-9]{32}$/.test(name))
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
