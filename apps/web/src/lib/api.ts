export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 空响应 */
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(
      res.status,
      (data.message as string) ?? `请求失败(${res.status})`,
      data.code as string | undefined,
    );
  }
  return data as T;
}

// ---------- 类型 ----------

export interface UserInfo {
  account: string;
  realname: string;
  lead: boolean;
  bridgeOk: boolean;
  passwordChangeRequired: boolean;
  ztUrl?: string;
}

export interface ExecutionDto {
  id: number;
  name: string;
  status: string;
  type: string;
  begin: string;
  end: string;
  progress: number;
  delay: number;
  tasksTotal: number;
}

export interface ProjectDto {
  id: number;
  name: string;
  code: string;
  status: string;
  begin: string;
  end: string;
  progress: number;
  programId: number;
  executions: ExecutionDto[];
  tasksTotal: number;
  doingExecutions: number;
  delayedExecutions: number;
}

export interface OverviewDto {
  programs: Array<{ id: number; name: string }>;
  projects: ProjectDto[];
}

export interface TaskDto {
  id: number;
  name: string;
  status: string;
  pri: number;
  estimate: number;
  consumed: number;
  left: number;
  deadline: string;
  estStarted: string;
  assignedTo: { account: string; realname: string } | null;
  projectId: number;
  projectName: string;
  executionId: number;
  executionName: string;
}

export interface LogItem {
  account: string;
  realname: string;
  date: string;
  taskId: number;
  taskName: string;
  projectName: string;
  executionName?: string;
  consumed: number;
  left?: number;
  work?: string;
  submittedAt: number;
}

export interface Bucket {
  key: string;
  total: number;
}

export interface MineEffort {
  total: number;
  byDate: Bucket[];
  byProject: Bucket[];
  items: LogItem[];
}

export interface TeamEffort extends Omit<MineEffort, "byDate" | "byProject"> {
  byAccount: Array<{ account: string; realname: string; total: number }>;
  byDate: Bucket[];
  byProject: Bucket[];
  meta?: string;
}

export interface PersonSummary {
  account: string;
  realname: string;
  estimate: number;
  consumed: number;
  left: number;
  taskCount: number;
}

export interface ProjectAgg {
  projectId: number;
  projectName: string;
  estimate: number;
  consumed: number;
  left: number;
  taskCount: number;
}

export interface SummaryDto {
  byProject: ProjectAgg[];
  byPerson: PersonSummary[];
}

// ---------- 常量 ----------

export const STATUS_LABEL: Record<string, string> = {
  wait: "未开始",
  doing: "进行中",
  done: "已完成",
  closed: "已关闭",
  pause: "已暂停",
  cancel: "已取消",
};

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  wait: "未开始",
  doing: "进行中",
  closed: "已关闭",
  done: "已完成",
  suspended: "已挂起",
};

export const PRI_COLOR: Record<number, string> = {
  1: "red",
  2: "orange",
  3: "blue",
  4: "default",
};

/** 项目配色（资源排期条/图例用，按名称稳定散列） */
const PALETTE = [
  "#1677ff", "#52c41a", "#faad14", "#f5222d", "#722ed1", "#13c2c2",
  "#eb2f96", "#fa8c16", "#2f54eb", "#a0d911", "#fadb14", "#1abc9c",
];

export function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
