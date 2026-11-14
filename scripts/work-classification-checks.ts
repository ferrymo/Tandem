import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WorkManagementService } from '../packages/application/src/work-management.js';
import type { StoredSession } from '../packages/core/src/index.js';

export async function checkWorkClassificationRemoval(input: {
  service: WorkManagementService;
  owner: StoredSession;
  member: StoredSession;
  outsider: StoredSession;
  workspaceId: string;
  otherWorkspaceId: string;
}) {
  const {
    service,
    owner,
    member,
    outsider,
    workspaceId: ws,
    otherWorkspaceId,
  } = input;
  const act = (value: Record<string, unknown>) =>
    service.execute(owner, ws, value);
  const parent = await act({
    command: 'save-project-group',
    name: '待整理分类',
  });
  const child = await act({
    command: 'save-project-group',
    name: '临时子分类',
    parentId: parent.id,
  });
  const groupRemoval = {
    command: 'remove-project-group',
    id: parent.id,
    version: 1,
  };
  await assert.rejects(act(groupRemoval), {
    code: 'CONFLICT',
    message: '分组下仍有子分组或项目，请先移出后再删除',
  });
  await assert.rejects(service.execute(member, ws, groupRemoval), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    service.execute(outsider, otherWorkspaceId, groupRemoval),
    { code: 'FORBIDDEN' },
  );
  await act({ command: 'remove-project-group', id: child.id, version: 1 });
  const edited = await act({
    command: 'save-project-group',
    id: parent.id,
    version: 1,
    name: '已更名分类',
  });
  await assert.rejects(act(groupRemoval), {
    code: 'CONFLICT',
    message: '分组已更新，请重新读取后删除',
  });
  await act({ ...groupRemoval, version: edited.version });
  assert.ok(
    !(await service.snapshot(owner, ws)).groups.some(
      (group) => group.id === parent.id || group.id === child.id,
    ),
  );

  const occupied = await act({
    command: 'save-project-group',
    name: '有项目分类',
  });
  const project = await act({
    command: 'save-project',
    name: '分类清理验证',
    groupId: occupied.id,
  });
  await assert.rejects(
    act({ command: 'remove-project-group', id: occupied.id, version: 1 }),
    { code: 'CONFLICT', message: '分组下仍有子分组或项目，请先移出后再删除' },
  );
  const grant = await act({
    command: 'save-project-member',
    projectId: project.id,
    participantId: member.identity.id,
    role: '研发',
    canWrite: false,
  });
  const module = await act({
    command: 'save-module',
    projectId: project.id,
    name: '临时模块',
  });
  const removal = {
    command: 'remove-module',
    id: module.id,
    version: 1,
    projectId: project.id,
  };
  await assert.rejects(service.execute(member, ws, removal), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(service.execute(outsider, otherWorkspaceId, removal), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(act({ ...removal, projectId: randomUUID() }), {
    code: 'FORBIDDEN',
  });
  const project2 = await act({ command: 'save-project', name: '其他项目' });
  await assert.rejects(act({ ...removal, projectId: project2.id }), {
    code: 'FORBIDDEN',
  });
  const renamed = await act({
    command: 'save-module',
    id: module.id,
    version: 1,
    projectId: project.id,
    name: '模块已更名',
  });
  await assert.rejects(act(removal), {
    code: 'CONFLICT',
    message: '模块已更新，请重新读取后删除',
  });
  await act({ ...removal, version: renamed.version });
  assert.ok(
    !(await service.snapshot(owner, ws)).modules.some(
      (item) => item.id === module.id,
    ),
  );

  const used = await act({
    command: 'save-module',
    projectId: project.id,
    name: '任务使用中',
  });
  const task = await act({
    command: 'save-task',
    projectId: project.id,
    moduleId: used.id,
    name: '保留历史任务',
  });
  const before = (await service.snapshot(owner, ws)).taskEvents.filter(
    (event) => event.taskId === task.id,
  );
  await assert.rejects(
    act({
      command: 'remove-module',
      id: used.id,
      version: 1,
      projectId: project.id,
    }),
    {
      code: 'CONFLICT',
      message: '模块仍被任务引用，请先调整任务所属模块后再删除',
    },
  );
  const after = await service.snapshot(owner, ws);
  assert.ok(after.projects.some((item) => item.id === project.id));
  assert.ok(after.modules.some((item) => item.id === used.id));
  assert.ok(
    after.tasks.some(
      (item) => item.id === task.id && item.moduleId === used.id,
    ),
  );
  assert.deepEqual(
    after.taskEvents.filter((event) => event.taskId === task.id),
    before,
  );
  await act({ command: 'remove-project-member', id: grant.id, version: 1 });
  console.log(
    '分类清理通过：空分组/未引用模块可删除，子分组/项目/任务引用拒绝，旧版本、只读成员与跨空间/跨项目拒绝，项目任务和历史保留。',
  );
}
