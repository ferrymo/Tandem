import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  DraftWorker,
  ProjectsService,
} from '../packages/application/src/projects.js';
import {
  createPool,
  PostgresCollaborationRepository,
  PostgresJobQueue,
  PostgresProjectsRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';
import type {
  Job,
  ProjectSystem,
  StoredSession,
  TaskDraftAction,
} from '../packages/core/src/index.js';

const keys = [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
] as const;
for (const key of keys)
  if (!process.env[key]) throw new Error('请先初始化 .env');
const name = 'tandem_projects_' + randomUUID().replaceAll('-', '');
const env = { ...process.env };
for (const key of keys) {
  const url = new URL(process.env[key]!);
  url.pathname = '/' + name;
  env[key] = url.toString();
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const fixture = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
const migrator = new pg.Client({
  connectionString: env.DATABASE_MIGRATION_URL,
});
const app = createPool(env.DATABASE_URL!);
const workerPool = createPool(env.WORKER_DATABASE_URL!);
const collaboration = new PostgresCollaborationRepository(app);
const projects = new PostgresProjectsRepository(app);
const workerRepo = new PostgresProjectsRepository(workerPool);
const queue = new PostgresJobQueue(workerPool);
const workerId = randomUUID();
const version = 'a'.repeat(64);
const action: TaskDraftAction = {
  kind: 'task.update',
  taskId: '10',
  expectedVersion: version,
  changes: { name: '经审批修改' },
};
const task = {
  id: '10',
  projectId: '1',
  executionId: '2',
  name: '原任务',
  status: 'wait',
  description: '',
  assignedTo: 'zhangsan',
  priority: 3,
  estimate: 2,
  deadline: '2026-12-01',
  consumed: 0,
  left: 2,
  realStarted: '',
  updatedAt: '2026-11-13 00:00:00',
  version,
};
let writes = 0;
let failSend = false;
let executedSubject = '';
function system(subject = 'owner'): ProjectSystem {
  return {
    connectionId: 'test-provider',
    projects: async () => ({
      items: [{ id: '1', name: '真实源测试项目', status: 'doing' }],
      total: 1,
      page: 1,
    }),
    project: async (id) => ({ id, name: '真实源测试项目', status: 'doing' }),
    executions: async () => [
      { id: '2', projectId: '1', name: '迭代', status: 'doing' },
    ],
    tasks: async () => ({ items: [task], total: 1, page: 1 }),
    task: async () => task,
    readAccessKey: async () => subject,
    assertWritable: async () => {},
    execute: async () => {
      writes++;
      executedSubject = subject;
      if (failSend) throw new Error('simulated lost response');
      return { taskId: '10', status: 'wait' };
    },
  };
}
async function session(
  subject: string,
  commander = false,
): Promise<StoredSession> {
  return collaboration.createSession({
    login: {
      providerId: 'test-provider',
      subject,
      displayName: subject,
      canCreateWorkspace: commander,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-test-ciphertext',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
}
async function claim(): Promise<Job> {
  const job = await queue.claim(workerId, 30000);
  assert.ok(job);
  return job;
}
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/db-bootstrap.ts'],
      { env, stdio: 'inherit', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('bootstrap failed')),
    );
  });
  await Promise.all([fixture.connect(), migrator.connect()]);
  for (const file of [
    '0001_foundation.sql',
    '0002_collaboration.sql',
    '0003_projects.sql',
  ]) {
    await migrator.query('BEGIN');
    await migrator.query(
      await readFile(
        new URL(
          '../packages/storage-postgres/migrations/' + file,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await migrator.query('COMMIT');
  }
  const owner = await session('张三', true),
    member = await session('李四'),
    outsider = await session('隔离用户', true);
  const space = await collaboration.createWorkspace(
    owner.identity.id,
    '项目验收空间',
    randomUUID(),
  );
  await collaboration.setMember(
    owner.identity.id,
    space.id,
    member.identity.id,
    'member',
  );
  const ownerScope = { workspaceId: space.id, actorId: owner.identity.id };
  const memberScope = { workspaceId: space.id, actorId: member.identity.id };
  const service = new ProjectsService(projects, system());
  const project = await service.bindProject(ownerScope, '1');
  await assert.rejects(projects.link(memberScope, project.id), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(projects.bind(memberScope, 'test-provider', '2'), {
    code: 'FORBIDDEN',
  });
  await projects.grant(ownerScope, project.id, member.identity.id, 'viewer');
  assert.equal((await projects.link(memberScope, project.id)).externalId, '1');
  await assert.rejects(projects.link(memberScope, project.id, true), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    projects.createDraft(
      memberScope,
      member.id,
      project.id,
      '无写权限',
      action,
      randomUUID(),
    ),
    { code: 'FORBIDDEN' },
  );
  await projects.grant(ownerScope, project.id, member.identity.id, 'editor');
  await service.addMessage(memberScope, project.id, '10', '这是本地任务讨论');
  assert.equal(
    (await service.messages(ownerScope, project.id, '10'))[0]?.body,
    '这是本地任务讨论',
  );
  const request = randomUUID();
  const created = await service.createDraft(
    memberScope,
    member.id,
    project.id,
    '修改任务',
    action,
    request,
  );
  assert.equal(
    (
      await service.createDraft(
        memberScope,
        member.id,
        project.id,
        '修改任务',
        action,
        request,
      )
    ).id,
    created.id,
  );
  await assert.rejects(
    service.createDraft(
      memberScope,
      member.id,
      project.id,
      '相同幂等键不同内容',
      action,
      request,
    ),
    { code: 'CONFLICT' },
  );
  await assert.rejects(projects.reviewDraft(memberScope, created.id, 1, true), {
    code: 'FORBIDDEN',
  });
  const revised = await service.reviseDraft(
    memberScope,
    created.id,
    1,
    '修改任务 V2',
    action,
  );
  assert.equal(revised.version, 2);
  await assert.rejects(service.reviewDraft(ownerScope, created.id, 1, true), {
    code: 'CONFLICT',
  });
  const reviews = await Promise.allSettled([
    service.reviewDraft(ownerScope, created.id, 2, true),
    service.reviewDraft(ownerScope, created.id, 2, true),
  ]);
  if (reviews.every((v) => v.status === 'rejected'))
    throw (reviews[0] as PromiseRejectedResult).reason;
  assert.equal(reviews.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(
    (await fixture.query('SELECT count(*)::int AS n FROM tandem.jobs')).rows[0]
      .n,
    1,
  );
  await assert.rejects(
    projects.reviseDraft(memberScope, created.id, 2, '批准后改内容', action),
    { code: 'CONFLICT' },
  );
  const approvedJob = await claim();
  const approvedFence = { job: approvedJob, workerId };
  assert.equal(
    (await workerRepo.workerContext(approvedFence))?.session.identity.id,
    member.identity.id,
  );
  const runner = new DraftWorker(workerRepo, async (original) =>
    system(original.identity.subject),
  );
  await runner.execute(approvedFence);
  assert.equal(writes, 1);
  assert.equal(executedSubject, '李四');
  assert.equal(
    (await projects.draft(ownerScope, created.id)).status,
    'succeeded',
  );
  assert.equal((await projects.link(ownerScope, project.id)).cacheVersion, '4');
  await runner.execute(approvedFence);
  assert.equal(writes, 1);
  assert.ok(await queue.complete(approvedJob, workerId));
  // A lost external response must become unknown and never be retried.
  const lost = await service.createDraft(
    memberScope,
    member.id,
    project.id,
    '响应丢失',
    action,
    randomUUID(),
  );
  await service.reviewDraft(ownerScope, lost.id, 1, true);
  const lostJob = await claim();
  failSend = true;
  await runner.execute({ job: lostJob, workerId });
  assert.equal((await projects.draft(ownerScope, lost.id)).status, 'unknown');
  await runner.execute({ job: lostJob, workerId });
  assert.equal(writes, 2);
  await assert.rejects(
    service.reviseDraft(memberScope, lost.id, 1, '不能盲重试', action),
    { code: 'CONFLICT' },
  );
  assert.ok(await queue.complete(lostJob, workerId));
  failSend = false;
  // A new lease must not resend an action interrupted after beginAction.
  const crash = await service.createDraft(
    memberScope,
    member.id,
    project.id,
    '发送后崩溃',
    action,
    randomUUID(),
  );
  await service.reviewDraft(ownerScope, crash.id, 1, true);
  const old = await claim();
  assert.ok(await workerRepo.beginAction({ job: old, workerId }));
  await fixture.query(
    "UPDATE tandem.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  const fresh = await claim();
  assert.notEqual(fresh.token, old.token);
  assert.equal(
    await workerRepo.finishAction(
      { job: old, workerId },
      { status: 'succeeded', receipt: { taskId: '10', status: 'wait' } },
    ),
    false,
  );
  await runner.execute({ job: fresh, workerId });
  assert.equal(writes, 2);
  assert.equal((await projects.draft(ownerScope, crash.id)).status, 'unknown');
  assert.ok(await queue.complete(fresh, workerId));
  // Revocation between approval and execution wins; the approver's credential is never used.
  const revoke = await service.createDraft(
    memberScope,
    member.id,
    project.id,
    '撤权阻止',
    action,
    randomUUID(),
  );
  await service.reviewDraft(ownerScope, revoke.id, 1, true);
  await projects.grant(ownerScope, project.id, member.identity.id, null);
  const revokedJob = await claim();
  assert.equal(
    await workerRepo.workerContext({ job: revokedJob, workerId }),
    null,
  );
  assert.equal(writes, 2);
  assert.equal(
    (await projects.draft(ownerScope, revoke.id)).error,
    'ORIGINAL_AUTH_REVOKED',
  );
  await assert.rejects(projects.draft(memberScope, revoke.id), {
    code: 'FORBIDDEN',
  });
  assert.ok(await queue.complete(revokedJob, workerId));
  await projects.grant(ownerScope, project.id, member.identity.id, 'editor');
  const extension = await projects.createDraft(
    memberScope,
    member.id,
    project.id,
    '明确工具失败',
    {
      kind: 'mcp.call',
      serverId: randomUUID(),
      serverRevision: 1,
      toolName: 'test.write',
      schemaHash: 'b'.repeat(64),
      projectId: project.id,
      teamId: randomUUID(),
      agentRole: 'engineer',
      arguments: {},
    },
    randomUUID(),
  );
  await projects.reviewDraft(ownerScope, extension.id, 1, true);
  const extensionJob = await claim();
  await new DraftWorker(workerRepo, async () => system(), {
    validate: async () => {},
    execute: async () => ({ status: 'failed', summary: '工具返回明确失败' }),
  }).execute({ job: extensionJob, workerId });
  const extensionResult = await projects.draft(ownerScope, extension.id);
  assert.equal(extensionResult.status, 'failed');
  assert.equal(extensionResult.receipt?.summary, '工具返回明确失败');
  assert.ok(await queue.complete(extensionJob, workerId));
  const expired = await service.createDraft(
    memberScope,
    member.id,
    project.id,
    '原会话退出',
    action,
    randomUUID(),
  );
  await service.reviewDraft(ownerScope, expired.id, 1, true);
  await fixture.query(
    'UPDATE tandem.sessions SET revoked_at=clock_timestamp(),encrypted_credential=NULL WHERE id=$1',
    [member.id],
  );
  const expiredJob = await claim();
  assert.equal(
    await workerRepo.workerContext({ job: expiredJob, workerId }),
    null,
  );
  assert.equal(
    (await projects.draft(ownerScope, expired.id)).error,
    'ORIGINAL_AUTH_REVOKED',
  );
  assert.ok(await queue.complete(expiredJob, workerId));
  const otherSpace = await collaboration.createWorkspace(
    outsider.identity.id,
    '隔离空间',
    randomUUID(),
  );
  const otherScope = {
    workspaceId: otherSpace.id,
    actorId: outsider.identity.id,
  };
  assert.equal((await projects.links(otherScope)).length, 0);
  await assert.rejects(projects.draft(otherScope, created.id), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    withScope(app, ownerScope, (client) =>
      client.query('SELECT tandem.project_draft_json($1)', [created.id]),
    ),
    /permission denied/,
  );
  await assert.rejects(
    withScope(app, ownerScope, (client) =>
      client.query(
        'UPDATE tandem.project_draft_versions SET title=$1 WHERE draft_id=$2',
        ['篡改', created.id],
      ),
    ),
    /permission denied/,
  );
  assert.equal(
    (
      await workerPool.query(
        'SELECT tandem.draft_worker_context($1,$2,$3) AS value',
        [approvedJob.id, approvedJob.token, randomUUID()],
      )
    ).rows[0].value,
    null,
  );
  console.log(
    '项目集成通过：显式授权、空间隔离、不可变审批版本、并发审批、原身份执行、跨进程缓存版本、未知结果防重试与过期租约围栏。',
  );
} finally {
  await Promise.allSettled([
    fixture.end(),
    migrator.end(),
    app.end(),
    workerPool.end(),
  ]);
  await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
