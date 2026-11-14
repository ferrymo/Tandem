import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { StoredSession } from '../packages/core/src/index.js';
import type { WorkManagementService } from '../packages/application/src/work-management.js';
import { withScope } from '../packages/storage-postgres/src/index.js';
import type { PostgresCollaborationRepository } from '../packages/storage-postgres/src/index.js';

export async function checkWorkRevocation(input: {
  app: pg.Pool;
  collaboration: PostgresCollaborationRepository;
  service: WorkManagementService;
  owner: StoredSession;
  workspaceId: string;
}) {
  const { app, collaboration, service, owner, workspaceId: ws } = input;
  const member = await collaboration.createSession({
    login: {
      providerId: owner.identity.providerId,
      subject: randomUUID(),
      displayName: '赵六',
      canCreateWorkspace: false,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-revocation-test',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await collaboration.setMember(
    owner.identity.id,
    ws,
    member.identity.id,
    'member',
  );
  const ownerAct = (data: Record<string, unknown>) =>
      service.execute(owner, ws, data),
    memberAct = (data: Record<string, unknown>) =>
      service.execute(member, ws, data);
  const first = await ownerAct({
      command: 'save-project',
      name: '工时历史项目',
    }),
    second = await ownerAct({ command: 'save-project', name: '工时当前项目' }),
    third = await ownerAct({ command: 'save-project', name: '工时并发项目' });
  const firstGrant = await ownerAct({
    command: 'save-project-member',
    projectId: first.id,
    participantId: member.identity.id,
    role: '研发',
    canWrite: true,
  });
  for (const projectId of [second.id, third.id])
    await ownerAct({
      command: 'save-project-member',
      projectId,
      participantId: member.identity.id,
      role: '研发',
      canWrite: true,
    });
  const a = await ownerAct({
      command: 'save-task',
      projectId: first.id,
      name: '历史工时',
    }),
    b = await ownerAct({
      command: 'save-task',
      projectId: second.id,
      name: '当前工时',
    }),
    c = await ownerAct({
      command: 'save-task',
      projectId: third.id,
      name: '并发工时',
    });
  const log = (taskId: string, hours: number) =>
    memberAct({
      command: 'log-efforts',
      requestId: randomUUID(),
      entries: [{ taskId, date: '2026-11-14', hours, note: '撤权回归' }],
    });
  await log(a.id!, 20);
  await ownerAct({
    command: 'remove-project-member',
    id: firstGrant.id,
    version: firstGrant.version,
  });
  assert.ok(
    !(await service.snapshot(member, ws)).projects.some(
      (p) => p.id === first.id,
    ),
  );
  await assert.rejects(log(b.id!, 20), { code: 'INVALID_INPUT' });
  const parallel = await Promise.allSettled([log(b.id!, 3), log(c.id!, 3)]);
  assert.equal(
    parallel.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    parallel.filter(
      (result) =>
        result.status === 'rejected' && result.reason?.code === 'INVALID_INPUT',
    ).length,
    1,
  );
  const total = (await service.snapshot(owner, ws)).efforts
    .filter((e) => e.actorId === member.identity.id && e.date === '2026-11-14')
    .reduce((n, e) => n + e.hours, 0);
  assert.equal(total, 23);
  const ownAggregate = await withScope(
    app,
    { workspaceId: ws, actorId: member.identity.id },
    async (client) =>
      (
        await client.query(
          'SELECT tandem.wm_actor_daily_hours($1)::float8 AS hours',
          ['2026-11-14'],
        )
      ).rows[0].hours,
  );
  assert.equal(ownAggregate, 23);
  const otherAggregate = await withScope(
    app,
    { workspaceId: ws, actorId: owner.identity.id },
    async (client) =>
      (
        await client.query(
          'SELECT tandem.wm_actor_daily_hours($1)::float8 AS hours',
          ['2026-11-14'],
        )
      ).rows[0].hours,
  );
  assert.notEqual(otherAggregate, 23);

  const authored = await memberAct({
    command: 'save-project',
    name: '作者移交项目',
  });
  const task = await memberAct({
    command: 'save-task',
    projectId: authored.id,
    name: '移交任务',
    assigneeId: member.identity.id,
  });
  const document = await memberAct({
    command: 'save-document',
    scope: 'project',
    projectId: authored.id,
    title: '移交文档',
    body: '原作者不可在撤权后继续访问',
  });
  const attachment = await service.createAttachment(member, ws, {
    taskId: task.id!,
    name: '移交资料.txt',
    mime: 'text/plain',
    size: 4,
    storageKey: randomUUID(),
  });
  const snapshot = await service.snapshot(owner, ws),
    project = snapshot.projects.find((p) => p.id === authored.id)!;
  await ownerAct({
    command: 'save-project',
    ...project,
    ownerId: owner.identity.id,
  });
  const grant = (await service.snapshot(owner, ws)).projectMembers.find(
    (m) =>
      m.projectId === authored.id && m.participantId === member.identity.id,
  )!;
  await ownerAct({
    command: 'remove-project-member',
    id: grant.id,
    version: grant.version,
  });
  const revoked = await service.snapshot(member, ws);
  assert.ok(!revoked.projects.some((p) => p.id === authored.id));
  assert.ok(!revoked.tasks.some((t) => t.id === task.id));
  assert.ok(!revoked.documents.some((d) => d.id === document.id));
  assert.ok(!revoked.attachments.some((a) => a.id === attachment.id));
  assert.ok(!revoked.taskEvents.some((e) => e.taskId === task.id));
  await assert.rejects(service.attachment(member, ws, attachment.id), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    memberAct({
      command: 'save-task',
      projectId: authored.id,
      name: '原作者不再有权写入',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    ownerAct({
      command: 'save-task',
      projectId: authored.id,
      name: '不可分配给已移除原作者',
      assigneeId: member.identity.id,
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    ownerAct({
      command: 'save-task',
      projectId: authored.id,
      name: '不可设置已移除原作者为协助人',
      collaboratorIds: [member.identity.id],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    withScope(app, { workspaceId: ws, actorId: member.identity.id }, (client) =>
      client.query('SELECT tandem.wm_bootstrap_project_member($1)', [
        authored.id,
      ]),
    ),
    { code: '42501' },
  );
  // Creating for a different owner still grants the creator an explicit, removable membership.
  const delegated = await memberAct({
    command: 'save-project',
    name: '直接指定其他负责人',
    ownerId: owner.identity.id,
  });
  const initial = (await service.snapshot(owner, ws)).projectMembers.find(
    (m) =>
      m.projectId === delegated.id && m.participantId === member.identity.id,
  )!;
  assert.ok(initial.canWrite);
  assert.ok(
    (await service.snapshot(member, ws)).projects.find(
      (p) => p.id === delegated.id,
    )?.canWrite,
  );
  await ownerAct({
    command: 'remove-project-member',
    id: initial.id,
    version: initial.version,
  });
  assert.ok(
    !(await service.snapshot(member, ws)).projects.some(
      (p) => p.id === delegated.id,
    ),
  );
  console.log(
    '撤权专项集成通过：原作者移交及移除后项目/任务/文档/附件/历史均不可读写；旧项目不能重建作者授权；日工时包含已撤权项目历史且并发跨项目不超24小时，聚合仅暴露当前用户本人。',
  );
}
