import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { StoredSession } from '../packages/core/src/index.js';
import type { WorkManagementService } from '../packages/application/src/work-management.js';
import {
  PostgresWorkCredentialRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';

export async function checkWorkRoles(input: {
  app: pg.Pool;
  service: WorkManagementService;
  owner: StoredSession;
  member: StoredSession;
  outsider: StoredSession;
  workspaceId: string;
  projectId: string;
  ownerTeamId: string;
  modelId: string;
}) {
  const {
    app,
    service,
    owner,
    member,
    outsider,
    workspaceId: ws,
    projectId,
    ownerTeamId,
    modelId,
  } = input;
  const ownerAct = (data: Record<string, unknown>) =>
    service.execute(owner, ws, data);
  const memberAct = (data: Record<string, unknown>) =>
    service.execute(member, ws, data);
  assert.deepEqual((await service.snapshot(member, ws)).permissions.sort(), [
    'document.manage',
    'project.create',
    'project.manage',
  ]);
  const readOnly = await ownerAct({
    command: 'save-role',
    name: '项目观察员',
    permissions: [],
    memberIds: [member.identity.id],
  });
  assert.deepEqual((await service.snapshot(member, ws)).permissions, []);
  await assert.rejects(
    memberAct({ command: 'save-project', name: '受限创建' }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    memberAct({
      command: 'save-document',
      title: '受限个人文档',
      scope: 'personal',
    }),
    { code: 'FORBIDDEN' },
  );
  const active = await ownerAct({
    command: 'save-role',
    id: readOnly.id,
    version: 1,
    name: '项目执行者',
    permissions: ['project.manage'],
    memberIds: [member.identity.id],
  });
  // Capability permission alone never grants access to project data or write ACL.
  await assert.rejects(
    memberAct({ command: 'save-task', projectId, name: '越过只读ACL' }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(
    (await service.snapshot(member, ws)).projects.find(
      (p) => p.id === projectId,
    )?.canWrite,
    false,
  );
  const acl = await ownerAct({
    command: 'save-project-member',
    projectId,
    participantId: member.identity.id,
    role: '项目协作验证',
    canWrite: true,
  });
  const task = await memberAct({
    command: 'save-task',
    projectId,
    name: '角色授权后的任务',
  });
  assert.ok(task.id);
  assert.equal(
    (await service.snapshot(member, ws)).projects.find(
      (p) => p.id === projectId,
    )?.canWrite,
    true,
  );
  await assert.rejects(
    memberAct({ command: 'save-project', name: '没有创建权限' }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    memberAct({
      command: 'save-document',
      scope: 'project',
      projectId,
      title: '没有文档权限',
    }),
    { code: 'FORBIDDEN' },
  );
  const docRole = await ownerAct({
    command: 'save-role',
    name: '文档协作者',
    permissions: ['document.manage'],
    memberIds: [member.identity.id],
  });
  assert.deepEqual((await service.snapshot(member, ws)).permissions.sort(), [
    'document.manage',
    'project.manage',
  ]);
  await memberAct({
    command: 'save-document',
    scope: 'project',
    projectId,
    title: '角色并集允许的文档',
  });
  await ownerAct({
    command: 'save-role',
    id: docRole.id,
    version: 1,
    name: '停用文档协作者',
    permissions: ['document.manage'],
    memberIds: [member.identity.id],
    enabled: false,
  });
  await ownerAct({
    command: 'save-role',
    id: active.id,
    version: active.version,
    name: '已停用执行者',
    permissions: ['project.manage'],
    memberIds: [member.identity.id],
    enabled: false,
  });
  assert.deepEqual((await service.snapshot(member, ws)).permissions, []);
  await assert.rejects(
    memberAct({ command: 'save-task', projectId, name: '停用后不可继续' }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(
    (await service.snapshot(member, ws)).projects.find(
      (p) => p.id === projectId,
    )?.canWrite,
    false,
  );
  const updated = await withScope(
    app,
    { workspaceId: ws, actorId: member.identity.id },
    async (c) =>
      c.query('UPDATE tandem.wm_tasks SET name=$1 WHERE id=$2 RETURNING id', [
        '直接SQL不可绕角色',
        task.id,
      ]),
  );
  assert.equal(updated.rowCount, 0);
  const manager = await ownerAct({
    command: 'save-role',
    name: '能力管理员',
    permissions: ['team.manage', 'agent.manage', 'config.manage'],
    memberIds: [member.identity.id],
  });
  const snapshot = await service.snapshot(member, ws);
  assert.equal(snapshot.canAdmin, false);
  assert.equal(snapshot.permissions.includes('config.manage'), true);
  const ownTeam = await memberAct({
    command: 'save-team',
    name: '李四团队',
    memberIds: [member.identity.id],
  });
  assert.equal(
    (await service.snapshot(member, ws)).teams.find((t) => t.id === ownTeam.id)
      ?.ownerId,
    member.identity.id,
  );
  await memberAct({
    command: 'save-team',
    id: ownTeam.id,
    version: 1,
    name: '本人团队改名',
    memberIds: [member.identity.id],
  });
  await assert.rejects(
    memberAct({
      command: 'save-team',
      id: ownerTeamId,
      version: 1,
      name: '不可接管他人团队',
      memberIds: [member.identity.id],
    }),
    { code: 'FORBIDDEN' },
  );
  const creatorRole = await ownerAct({
    command: 'save-role',
    name: '仅创建项目',
    permissions: ['project.create'],
    memberIds: [member.identity.id],
  });
  const created = await memberAct({
    command: 'save-project',
    name: '仅创建权限的项目',
  });
  assert.ok(created.id);
  assert.equal(
    (await service.snapshot(member, ws)).projects.find(
      (p) => p.id === created.id,
    )?.canWrite,
    false,
  );
  await assert.rejects(
    memberAct({
      command: 'save-module',
      projectId: created.id,
      name: '不可自动扩大管理权限',
    }),
    { code: 'FORBIDDEN' },
  );
  await ownerAct({
    command: 'save-role',
    id: creatorRole.id,
    version: 1,
    name: '停用创建项目',
    permissions: ['project.create'],
    memberIds: [member.identity.id],
    enabled: false,
  });
  const sandbox = await memberAct({
    command: 'save-sandbox',
    name: '委托管理的执行器',
    image: 'node:24-alpine',
  });
  const channel = await memberAct({
    command: 'save-model-channel',
    name: '委托管理的模型',
    baseUrl: 'https://model.example.com/v1',
  });
  await memberAct({
    command: 'save-agent',
    name: '委托管理的Bot',
    sandboxId: sandbox.id,
    modelChannelId: channel.id,
    teamId: ownTeam.id,
  });
  await assert.rejects(
    memberAct({
      command: 'save-role',
      name: '不可再授权',
      permissions: ['project.manage'],
      memberIds: [member.identity.id],
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    memberAct({ command: 'save-menu', key: 'admin', label: '提权菜单' }),
    { code: 'FORBIDDEN' },
  );
  const credentials = new PostgresWorkCredentialRepository(app);
  assert.deepEqual(
    await credentials.states({ workspaceId: ws, actorId: member.identity.id }),
    [],
  );
  await assert.rejects(
    credentials.read(
      { workspaceId: ws, actorId: member.identity.id },
      'model-channel',
      modelId,
    ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    ownerAct({
      command: 'save-role',
      name: '跨空间成员',
      permissions: ['config.manage'],
      memberIds: [outsider.identity.id],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    ownerAct({
      command: 'remove-configuration',
      kind: 'role',
      id: manager.id,
      version: 1,
    }),
    { code: 'CONFLICT' },
  );
  // Project assignment revocation and role disablement become visible on the next request.
  await ownerAct({ command: 'remove-project-member', id: acl.id, version: 1 });
  await ownerAct({
    command: 'save-role',
    id: manager.id,
    version: 1,
    name: '已停用能力管理员',
    permissions: ['team.manage', 'agent.manage', 'config.manage'],
    memberIds: [member.identity.id],
    enabled: false,
  });
  assert.deepEqual((await service.snapshot(member, ws)).permissions, []);
  await assert.rejects(
    memberAct({
      command: 'save-sandbox',
      name: '停用后不能创建',
      image: 'node:24-alpine',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    memberAct({
      command: 'save-task',
      projectId: randomUUID(),
      name: '不能绕范围',
    }),
    { code: 'FORBIDDEN' },
  );
  console.log(
    '角色集成通过：成员绑定、启停即时生效、只读角色限制、项目ACL独立校验、委托团队/Agent/配置管理、禁止升级空间角色或读取密钥、直接SQL的RLS约束。',
  );
}
