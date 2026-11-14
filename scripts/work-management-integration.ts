import assert from 'node:assert/strict';
import { checkWorkRoles } from './work-role-checks.js';
import { checkWorkRevocation } from './work-revocation-checks.js';
import { checkTaskAttachmentHistory } from './task-attachment-history-checks.js';
import { checkWorkClassificationRemoval } from './work-classification-checks.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { WorkManagementService } from '../packages/application/src/work-management.js';
import {
  createPool,
  PostgresCollaborationRepository,
  PostgresWorkManagementRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';
import type { StoredSession } from '../packages/core/src/index.js';
import { checkWorkCredentials } from './work-credentials-checks';

const keys = [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
] as const;
const name = 'tandem_work_' + randomUUID().replaceAll('-', '');
const env = { ...process.env };
for (const key of keys) {
  if (!env[key]) throw new Error('请先初始化 .env');
  const url = new URL(env[key]!);
  url.pathname = '/' + name;
  env[key] = url.toString();
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const app = createPool(env.DATABASE_URL!);
const repo = new PostgresWorkManagementRepository(app);
const service = new WorkManagementService(repo);
const collab = new PostgresCollaborationRepository(app);
const run = (file: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      env,
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(file + ' failed: ' + output)),
    );
  });
async function session(subject: string): Promise<StoredSession> {
  return collab.createSession({
    login: {
      providerId: 'isolated-work-test',
      subject,
      displayName: subject,
      canCreateWorkspace: true,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-test-only',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
}
try {
  await run('scripts/db-bootstrap.ts');
  await run('scripts/db-migrate.ts');
  const owner = await session('张三'),
    member = await session('李四'),
    outsider = await session('王五');
  const workspace = await collab.createWorkspace(
    owner.identity.id,
    '工作管理隔离验证',
    randomUUID(),
  );
  const ws = workspace.id;
  await collab.setMember(owner.identity.id, ws, member.identity.id, 'member');
  const act = (input: Record<string, unknown>) =>
    service.execute(owner, ws, input);
  const group = await act({ command: 'save-project-group', name: '客户项目' });
  const child = await act({
    command: 'save-project-group',
    name: '实施项目',
    parentId: group.id,
  });
  await assert.rejects(
    act({
      command: 'save-project-group',
      id: group.id,
      version: 1,
      name: '循环分组',
      parentId: child.id,
    }),
    { code: 'INVALID_INPUT' },
  );
  const p1 = await act({
    command: 'save-project',
    name: '项目甲',
    groupId: child.id,
    initiatedOn: '2026-11-01',
    launchOn: '2026-12-01',
    plannedDays: 20,
    plannedAmount: 100000,
  });
  const p2 = await act({ command: 'save-project', name: '项目乙' });
  assert.equal((await service.snapshot(member, ws)).projects.length, 0);
  const grant = await act({
    command: 'save-project-member',
    projectId: p1.id,
    participantId: member.identity.id,
    role: '研发',
    canWrite: false,
  });
  assert.equal((await service.snapshot(member, ws)).projects.length, 1);
  const module = await act({
    command: 'save-module',
    projectId: p1.id,
    name: '登录模块',
  });
  const t1 = await act({
    command: 'save-task',
    projectId: p1.id,
    moduleId: module.id,
    name: '实现登录',
    assigneeId: owner.identity.id,
    collaboratorIds: [member.identity.id],
    plannedStart: '2026-11-14',
    plannedEnd: '2026-11-20',
    plannedHours: 16,
  });
  const t2 = await act({
    command: 'save-task',
    projectId: p2.id,
    name: '方案设计',
    plannedHours: 8,
  });
  await assert.rejects(
    act({
      command: 'save-task',
      projectId: p2.id,
      moduleId: module.id,
      name: '跨项目模块',
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    act({
      command: 'save-task',
      id: t1.id,
      version: 1,
      projectId: p1.id,
      name: '无原因取消',
      status: 'cancelled',
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    service.execute(member, ws, {
      command: 'save-task',
      id: t1.id,
      version: 1,
      projectId: p1.id,
      name: '越权编辑',
    }),
    { code: 'FORBIDDEN' },
  );
  await act({ command: 'add-task-comment', taskId: t1.id, body: '接口已确认' });
  const personal = await act({
    command: 'save-document',
    title: '个人研究',
    scope: 'personal',
    body: '# 私有记录',
  });
  const projectDoc = await act({
    command: 'save-document',
    title: '项目方案',
    scope: 'project',
    projectId: p1.id,
    body: '# 项目方案',
  });
  const privateDoc = await act({
    command: 'save-document',
    title: '私密报价',
    scope: 'project',
    projectId: p1.id,
    visibility: 'private',
    body: '报价明细',
  });
  const team = await act({
    command: 'save-team',
    name: '研发团队',
    memberIds: [owner.identity.id, member.identity.id],
  });
  await act({
    command: 'save-document',
    title: '技术规范',
    scope: 'team',
    teamId: team.id,
    body: '# 规范',
  });
  const memberData = await service.snapshot(member, ws);
  assert.deepEqual(memberData.documents.map((d) => d.title).sort(), [
    '技术规范',
    '项目方案',
  ]);
  const attachment = await service.createAttachment(owner, ws, {
    taskId: t1.id!,
    name: '需求.txt',
    mime: 'text/plain',
    size: 4,
    storageKey: randomUUID(),
  });
  const privateAttachment = await service.createAttachment(owner, ws, {
    documentId: personal.id!,
    name: '研究.txt',
    mime: 'text/plain',
    size: 4,
    storageKey: randomUUID(),
  });
  await assert.rejects(
    service.createAttachment(owner, ws, {
      projectId: p2.id!,
      taskId: t1.id!,
      name: '错误.txt',
      mime: 'text/plain',
      size: 4,
      storageKey: randomUUID(),
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    service.createAttachment(member, ws, {
      taskId: t1.id!,
      name: '越权.txt',
      mime: 'text/plain',
      size: 4,
      storageKey: randomUUID(),
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal((await service.attachment(member, ws, attachment.id)).size, 4);
  await assert.rejects(service.attachment(member, ws, privateAttachment.id), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(service.deleteAttachment(member, ws, attachment.id), {
    code: 'FORBIDDEN',
  });
  assert.ok(
    !(await service.snapshot(owner, ws)).attachments.some(
      (a) => 'storageKey' in a,
    ),
  );
  const batch = randomUUID();
  const entries = [
    { taskId: t1.id, date: '2026-11-14', hours: 4, note: '登录开发' },
    { taskId: t2.id, date: '2026-11-14', hours: 2, note: '方案设计' },
  ];
  await Promise.all([
    act({ command: 'log-efforts', requestId: batch, entries }),
    act({ command: 'log-efforts', requestId: batch, entries }),
  ]);
  let data = await service.snapshot(owner, ws);
  assert.equal(data.efforts.length, 2);
  assert.equal(data.tasks.find((t) => t.id === t1.id)?.actualHours, 4);
  assert.equal(data.tasks.find((t) => t.id === t2.id)?.actualHours, 2);
  await assert.rejects(
    act({
      command: 'log-efforts',
      requestId: batch,
      entries: [{ ...entries[0], hours: 3 }],
    }),
    { code: 'CONFLICT' },
  );
  await assert.rejects(
    act({
      command: 'log-efforts',
      requestId: randomUUID(),
      entries: [{ ...entries[0], hours: 20 }],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    act({
      command: 'log-efforts',
      requestId: randomUUID(),
      entries: [entries[0], { ...entries[1], taskId: randomUUID() }],
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal((await service.snapshot(owner, ws)).efforts.length, 2);
  await assert.rejects(
    act({
      command: 'save-task',
      id: t1.id,
      version: 1,
      projectId: p1.id,
      name: '旧版本',
    }),
    { code: 'CONFLICT' },
  );
  const task = data.tasks.find((t) => t.id === t1.id)!;
  await act({
    command: 'save-task',
    ...task,
    status: 'cancelled',
    cancellationReason: '需求调整',
  });
  data = await service.snapshot(owner, ws);
  assert.equal(data.taskEvents.filter((e) => e.taskId === t1.id).length, 5);
  assert.equal(
    data.tasks.find((t) => t.id === t1.id)?.cancellationReason,
    '需求调整',
  );
  await act({
    command: 'save-document',
    id: projectDoc.id,
    version: 1,
    title: '项目方案 v2',
    body: '# 第二版',
    scope: 'project',
    projectId: p1.id,
  });
  const count = await withScope(
    app,
    { workspaceId: ws, actorId: owner.identity.id },
    async (c) =>
      (
        await c.query(
          'SELECT count(*)::integer AS n FROM tandem.wm_document_versions WHERE document_id=$1',
          [projectDoc.id],
        )
      ).rows[0].n,
  );
  assert.equal(count, 2);
  await assert.rejects(
    service.execute(member, ws, {
      command: 'save-document',
      id: privateDoc.id,
      version: 1,
      title: '窃取',
      body: '',
      scope: 'project',
      projectId: p1.id,
    }),
    { code: 'FORBIDDEN' },
  );
  const sandbox = await act({
    command: 'save-sandbox',
    name: 'Node执行器',
    image: 'node:24-alpine',
  });
  const model = await act({
    command: 'save-model-channel',
    name: '测试渠道',
    baseUrl: 'https://api.example.com/v1',
    models: ['model'],
    credentialRef: 'TANDEM_TEST_API_KEY',
  });
  const agent = await act({
    command: 'save-agent',
    name: '研发助手',
    teamId: team.id,
    modelChannelId: model.id,
    sandboxId: sandbox.id,
  });
  await act({
    command: 'save-project-member',
    projectId: p1.id,
    participantId: agent.id,
    role: '研发',
    canWrite: false,
  });
  await assert.rejects(
    act({
      command: 'remove-configuration',
      kind: 'agent',
      id: agent.id,
      version: 1,
    }),
    { code: 'CONFLICT' },
  );
  await assert.rejects(
    act({
      command: 'save-model-channel',
      name: '带密钥URL',
      baseUrl: 'https://user:key@example.com/v1',
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    service.execute(member, ws, {
      command: 'save-role',
      name: '提权',
      permissions: ['config.manage'],
    }),
    { code: 'FORBIDDEN' },
  );
  const other = await collab.createWorkspace(
    outsider.identity.id,
    '其他空间',
    randomUUID(),
  );
  await checkWorkCredentials({
    app,
    service,
    owner,
    member,
    outsider,
    workspaceId: ws,
    otherWorkspaceId: other.id,
    modelId: model.id!,
  });
  await checkTaskAttachmentHistory({
    app,
    collaboration: collab,
    service,
    owner,
    member,
    workspaceId: ws,
  });
  await checkWorkClassificationRemoval({
    service,
    owner,
    member,
    outsider,
    workspaceId: ws,
    otherWorkspaceId: other.id,
  });
  await checkWorkRoles({
    app,
    service,
    owner,
    member,
    outsider,
    workspaceId: ws,
    projectId: p1.id!,
    ownerTeamId: team.id!,
    modelId: model.id!,
  });
  await assert.rejects(service.snapshot(outsider, ws), { code: 'FORBIDDEN' });
  await assert.rejects(
    service.execute(outsider, other.id, {
      command: 'save-project',
      name: '跨空间分组',
      groupId: group.id,
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(service.attachment(outsider, other.id, attachment.id), {
    code: 'FORBIDDEN',
  });
  await act({ command: 'remove-project-member', id: grant.id, version: 1 });
  await assert.rejects(service.attachment(member, ws, attachment.id), {
    code: 'FORBIDDEN',
  });
  assert.equal((await service.snapshot(member, ws)).taskEvents.length, 0);
  await service.deleteAttachment(owner, ws, attachment.id);
  await assert.rejects(service.attachment(owner, ws, attachment.id), {
    code: 'FORBIDDEN',
  });
  await checkWorkRevocation({
    app,
    collaboration: collab,
    service,
    owner,
    workspaceId: ws,
  });
  console.log(
    '工作管理集成通过：项目/模块/团队、文档版本及个人/团队/项目可见性、附件逐资源授权、撤权与空间隔离、任务时间轴、乐观版本、跨项目批量工时事务和并发幂等、配置权限。',
  );
} finally {
  await app.end();
  await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
