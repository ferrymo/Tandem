/**
 * 连接器端口（Ports）——产品层/智能层只依赖这些接口，不感知任何下游系统。
 * 新增连接器 = 在 adapters/ 下实现本文件的接口（见 docs/02-技术架构文档.md §3.1）。
 */

export type ID = number

export interface Project {
  id: ID
  name: string
  status: string
  progress: number
  begin?: string
  end?: string
}

export interface Execution {
  id: ID
  projectId: ID
  name: string
  status: string
  begin?: string
  end?: string
  progress: number
}

export interface Task {
  id: ID
  name: string
  projectId: ID
  projectName?: string
  executionId: ID
  executionName?: string
  status: string
  pri: number
  type?: string
  estimate: number
  consumed: number
  left: number
  deadline?: string
  estStarted?: string
  assignedTo?: {account: string; realname: string}
  desc?: string
}

export interface TaskInput {
  executionId: ID
  name: string
  type?: string
  pri?: number
  estimate?: number
  assignedTo?: string[]
  estStarted?: string
  deadline?: string
  desc?: string
}

export type StatusAction = 'start' | 'pause' | 'restart' | 'finish' | 'close'

export interface EffortEntry {
  date?: string
  consumed: number
  left: number
  work?: string
}

export interface WorkerLite {
  account: string
  realname: string
}

/** 一次已认证的连接会话（凭证随会话，权限即本人） */
export interface AdapterSession {
  readonly account: string
}

/**
 * 协作系统适配器接口。
 * 契约：读操作直接返回；写操作仅供草案引擎（drafts.ts）调用，UI/Agent 不得直连。
 */
export interface CollabAdapter {
  readonly id: string
  readonly label: string

  /** 是否具备网页桥接能力（如记工时/删除），由适配器自行判定 */
  capabilities(): Promise<{logEffort: boolean; deleteTask: boolean; reason?: string}>

  // ---- 读 ----
  listProjects(s: AdapterSession): Promise<Project[]>
  listExecutions(s: AdapterSession, projectId: ID): Promise<Execution[]>
  listTasks(s: AdapterSession, filter?: {mine?: boolean}): Promise<Task[]>
  getTask(s: AdapterSession, id: ID): Promise<Task>
  listWorkers(s: AdapterSession): Promise<WorkerLite[]>

  // ---- 写（仅草案引擎调用）----
  createTask(s: AdapterSession, input: TaskInput): Promise<{id: ID}>
  changeTaskStatus(s: AdapterSession, id: ID, action: StatusAction, body?: {consumed?: number; left?: number; comment?: string}): Promise<void>
  logEffort(s: AdapterSession, taskId: ID, e: EffortEntry): Promise<void>
  deleteTask(s: AdapterSession, id: ID): Promise<void>
}

/** 适配器注册表：产品层按 id 取适配器，不 import 具体实现 */
export class AdapterRegistry {
  private map = new Map<string, CollabAdapter>()
  register(a: CollabAdapter) {
    this.map.set(a.id, a)
  }
  get(id: string): CollabAdapter | undefined {
    return this.map.get(id)
  }
  get default(): CollabAdapter | undefined {
    return this.map.values().next().value
  }
  list(): CollabAdapter[] {
    return [...this.map.values()]
  }
}
