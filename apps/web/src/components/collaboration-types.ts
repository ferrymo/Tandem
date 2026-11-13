export type User = {
  id: string;
  displayName: string;
  canCreateWorkspace: boolean;
};
export type Workspace = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
};
export type Overview = {
  workspace: Workspace;
  team: {
    id: string;
    name: string;
    templateVersion: number;
    ownerId: string;
    ownerDisplayName: string;
    agents: { id: string; role: string; name: string; description: string }[];
  };
};
export type Member = {
  identityId: string;
  displayName: string;
  role: Workspace['role'];
};
export type View =
  'focus' | 'agents' | 'tasks' | 'observe' | 'connect' | 'capabilities';
export const navigation: { view: View; label: string }[] = [
  { view: 'focus', label: '关注' },
  { view: 'agents', label: 'Agents' },
  { view: 'tasks', label: '任务' },
  { view: 'observe', label: '观察' },
  { view: 'connect', label: '连接' },
  { view: 'capabilities', label: '能力' },
];
export const roleNames = { owner: '创建人', admin: '管理员', member: '成员' };
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 401
        ? '登录已失效，请重新登录。'
        : response.status === 403
          ? data?.error?.message || '当前内容不可用或无访问权限。'
          : data?.error?.message || '服务暂不可用，请稍后重试。';
    throw new ApiError(response.status, message);
  }
  return data as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '连接中断，请重试。';
}
