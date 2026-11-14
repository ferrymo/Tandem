export type * from '@tandem/core';
import type { WorkSnapshot } from '@tandem/core';
import type { ProductClient } from './product-api';
export type WorkSurfaceProps = {
  data: WorkSnapshot;
  client: ProductClient;
  onCommand: (
    command: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
};
export const stageLabels: Record<string, string> = {
  presales: '售前',
  initiated: '立项',
  executing: '执行',
  launched: '上线',
  maintenance: '维护',
  closed: '结束',
  frozen: '冻结',
  cancelled: '取消',
};
export const statusLabels: Record<string, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  closed: '已结束',
  paused: '已暂停',
  cancelled: '已取消',
};
export const commonRoles = ['销售', '策划', '项目经理', '研发', '运营', '学术'];
export function can(data: WorkSnapshot, permission: string) {
  return data.canAdmin || (data.permissions ?? []).includes(permission);
}
export function canWriteProject(data: WorkSnapshot, id: string) {
  const project = data.projects.find((p) => p.id === id);
  if (typeof project?.canWrite === 'boolean') return project.canWrite;
  return (
    can(data, 'project.manage') &&
    (data.canAdmin ||
      data.projects.some((p) => p.id === id && p.ownerId === data.actorId) ||
      data.projectMembers.some(
        (m) =>
          m.projectId === id && m.participantId === data.actorId && m.canWrite,
      ))
  );
}
export function hasProjectWriteAccess(data: WorkSnapshot, id: string) {
  return (
    data.canAdmin ||
    data.projects.some((p) => p.id === id && p.ownerId === data.actorId) ||
    data.projectMembers.some(
      (m) =>
        m.projectId === id && m.participantId === data.actorId && m.canWrite,
    )
  );
}
export function projectPeople(data: WorkSnapshot, id: string) {
  return data.participants.filter(
    (p) =>
      data.projectMembers.some(
        (m) => m.projectId === id && m.participantId === p.id,
      ) ||
      data.projects.some(
        (project) => project.id === id && project.ownerId === p.id,
      ),
  );
}
export function day(value: string | null) {
  return value ? value.slice(0, 10) : '未设置';
}
export function person(data: WorkSnapshot, id: string | null) {
  return data.participants.find((p) => p.id === id)?.name ?? '未分配';
}
export function money(value: number | null) {
  return value === null
    ? '未设置'
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        maximumFractionDigits: 2,
      }).format(value);
}
