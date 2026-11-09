import { randomUUID } from 'node:crypto'
import { WebBridge, ZentaoClient, type ZtExecution, type ZtProject, type ZtTask } from '@tandem/adapter-zentao'

/** 草稿动作：AI 提案、人确认后才执行 */
export type DraftAction =
  | {
      type: 'create_task'
      executionId: number
      name: string
      taskType?: string
      pri?: number
      estimate?: number
      assignedTo?: string[]
      estStarted?: string
      deadline?: string
      desc?: string
    }
  | {
      type: 'update_task_status'
      taskId: number
      action: 'start' | 'pause' | 'restart' | 'finish' | 'close'
      consumed?: number
      left?: number
      comment?: string
    }
  | { type: 'log_effort'; taskId: number; date?: string; consumed: number; left: number; work?: string }
  | { type: 'create_project'; name: string; begin?: string; end?: string; parent?: number }

export interface ValidationIssue {
  index: number
  ok: boolean
  message: string
}

export interface Draft {
  id: string
  createdAt: number
  actions: DraftAction[]
  validation: ValidationIssue[]
  status: 'pending' | 'executed' | 'discarded'
  results?: Array<{ index: number; type: string; ok: boolean; message: string }>
}

const DRAFT_TTL = 30 * 60 * 1000
const CACHE_TTL = 3 * 60 * 1000

export class ZtState {
  readonly account: string
  readonly client: ZentaoClient
  readonly bridge: WebBridge
  readonly drafts = new Map<string, Draft>()

  private projectCache?: { at: number; data: ZtProject[] }
  private execCache = new Map<number, { at: number; data: ZtExecution[] }>()
  private taskCache?: { at: number; data: ZtTask[] }

  constructor(account: string, client: ZentaoClient, bridge: WebBridge) {
    this.account = account
    this.client = client
    this.bridge = bridge
  }

  // ---------- 缓存 ----------

  async projects(): Promise<ZtProject[]> {
    if (this.projectCache && Date.now() - this.projectCache.at < CACHE_TTL) return this.projectCache.data
    const data = await this.client.listProjects()
    this.projectCache = { at: Date.now(), data }
    return data
  }

  async executions(projectId: number): Promise<ZtExecution[]> {
    const hit = this.execCache.get(projectId)
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data
    const data = await this.client.listProjectExecutions(projectId).catch(() => [])
    this.execCache.set(projectId, { at: Date.now(), data })
    return data
  }

  /** 全量任务（含翻页聚合，3 分钟缓存） */
  async tasks(): Promise<ZtTask[]> {
    if (this.taskCache && Date.now() - this.taskCache.at < CACHE_TTL) return this.taskCache.data
    const projects = await this.projects()
    const all: ZtTask[] = []
    await ZentaoClient.pooled(projects, 3, async (p) => {
      const execs = await this.executions(p.id)
      await ZentaoClient.pooled(execs, 4, async (e) => {
        try {
          const list = await this.client.listExecutionTasks(e.id)
          for (const t of list) if (t.parent === 0) all.push(t)
        } catch {
          /* 单个执行失败不阻塞 */
        }
      })
    })
    this.taskCache = { at: Date.now(), data: all }
    return all
  }

  dropCaches() {
    this.projectCache = undefined
    this.execCache.clear()
    this.taskCache = undefined
  }

  async taskById(taskId: number): Promise<ZtTask> {
    return this.client.getTask(taskId)
  }

  // ---------- 草稿 ----------

  newDraft(actions: DraftAction[], validation: ValidationIssue[]): Draft {
    const d: Draft = {
      id: randomUUID().slice(0, 8),
      createdAt: Date.now(),
      actions,
      validation,
      status: 'pending',
    }
    this.drafts.set(d.id, d)
    this.gc()
    return d
  }

  private gc() {
    const now = Date.now()
    for (const [id, d] of this.drafts) if (now - d.createdAt > DRAFT_TTL) this.drafts.delete(id)
  }
}

/** 执行单个草稿动作（调用方负责 try/catch） */
export async function executeAction(s: ZtState, a: DraftAction): Promise<string> {
  switch (a.type) {
    case 'create_task': {
      // 该实例创建任务必填预计开始（实测 21.7.9），缺省取今天
      const t = await s.client.createTask(a.executionId, {
        name: a.name,
        type: a.taskType ?? 'devel',
        pri: a.pri ?? 3,
        estimate: a.estimate ?? 0,
        assignedTo: a.assignedTo ?? [],
        estStarted: a.estStarted ?? new Date().toISOString().slice(0, 10),
        ...(a.deadline ? { deadline: a.deadline } : {}),
        ...(a.desc ? { desc: a.desc } : {}),
      })
      s.dropCaches()
      return `任务 #${t.id}「${a.name}」已创建（执行 ${a.executionId}）`
    }
    case 'update_task_status': {
      const body: Record<string, unknown> = {}
      if (a.type === 'update_task_status' && a.action === 'finish') {
        body.consumed = a.consumed ?? 0
        body.left = a.left ?? 0
        if (a.comment) body.comment = a.comment
      }
      await s.client.taskAction(a.taskId, a.action, body)
      s.dropCaches()
      return `任务 #${a.taskId} 已执行动作 ${a.action}`
    }
    case 'log_effort': {
      await s.bridge.recordEstimate(a.taskId, {
        date: a.date ?? new Date().toISOString().slice(0, 10),
        consumed: a.consumed,
        left: a.left,
        work: a.work,
      })
      const t = await s.taskById(a.taskId)
      s.dropCaches()
      return `任务 #${a.taskId} 已登记 ${a.consumed}h（累计 ${t.consumed}h）`
    }
    case 'create_project': {
      const today = new Date().toISOString().slice(0, 10)
      const p = await s.client.post<{ id: number }>('projects', {
        name: a.name,
        model: 'scrum',
        begin: a.begin ?? today,
        end: a.end ?? today,
        days: 1,
        ...(a.parent ? { parent: a.parent } : {}),
      })
      s.dropCaches()
      return `项目「${a.name}」已创建（id=${p.id}）`
    }
  }
}
