/**
 * 禅道连接器：把 zentao-sdk 的原始能力适配成 core 的统一端口（CollabAdapter）。
 * 产品层只认端口，不认识"禅道"。
 */
import {
  WebBridge,
  ZentaoClient,
  PasswordChangeRequiredError,
  type ZtTask,
  type ZtProject,
  type ZtExecution,
} from './index.js'
import type {
  AdapterSession,
  CollabAdapter,
  EffortEntry,
  Execution,
  ID,
  Project,
  StatusAction,
  Task,
  TaskInput,
  WorkerLite,
} from '@tandem/core'

const num = (v: string | number | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** 会话实现：持有该账号的 REST 客户端与网页桥接 */
export class ZentaoSession implements AdapterSession {
  constructor(
    readonly account: string,
    readonly client: ZentaoClient,
    readonly bridge: WebBridge,
    public bridgeOk = false,
    public bridgeReason?: string,
  ) {}
}

function toProject(p: ZtProject): Project {
  return {id: p.id, name: p.name, status: p.status, progress: num(p.progress), begin: p.begin, end: p.end}
}
function toExecution(e: ZtExecution, projectId: ID): Execution {
  return {id: e.id, projectId, name: e.name, status: e.status, begin: e.begin, end: e.end, progress: num(e.progress)}
}
function toTask(t: ZtTask): Task {
  return {
    id: t.id,
    name: t.name,
    projectId: t.project,
    executionId: t.execution,
    status: t.status,
    pri: t.pri,
    type: t.type,
    estimate: num(t.estimate),
    consumed: num(t.consumed),
    left: num(t.left),
    deadline: t.deadline || undefined,
    estStarted: t.estStarted || undefined,
    assignedTo: t.assignedTo ? {account: t.assignedTo.account, realname: t.assignedTo.realname} : undefined,
    desc: t.desc,
  }
}

export class ZentaoAdapter implements CollabAdapter {
  readonly id = 'zentao'
  readonly label = '禅道'

  constructor(private readonly baseUrl: string) {}

  /** 建立一次连接会话（REST + 尝试网页桥接） */
  async connect(account: string, password: string): Promise<ZentaoSession> {
    const client = await ZentaoClient.login(this.baseUrl, account, password)
    const bridge = new WebBridge(this.baseUrl)
    let bridgeOk = false
    let bridgeReason: string | undefined
    try {
      await bridge.login(account, password)
      bridgeOk = true
    } catch (e) {
      bridgeReason =
        e instanceof PasswordChangeRequiredError
          ? '账号被要求先修改密码，记工时/删除不可用'
          : e instanceof Error
            ? e.message
            : String(e)
    }
    return new ZentaoSession(account, client, bridge, bridgeOk, bridgeReason)
  }

  private need(s: AdapterSession): ZentaoSession {
    if (!(s instanceof ZentaoSession)) throw new Error('会话与连接器不匹配')
    return s
  }

  async capabilities(s?: AdapterSession): Promise<{logEffort: boolean; deleteTask: boolean; reason?: string}> {
    const sess = s && s instanceof ZentaoSession ? s : undefined
    const ok = sess?.bridgeOk ?? false
    return {logEffort: ok, deleteTask: ok, reason: ok ? undefined : sess?.bridgeReason ?? '网页桥接未建立'}
  }

  // ---- 读 ----

  async listProjects(s: AdapterSession): Promise<Project[]> {
    const projects = await this.need(s).client.listProjects()
    return projects.map(toProject)
  }

  async listExecutions(s: AdapterSession, projectId: ID): Promise<Execution[]> {
    const execs = await this.need(s).client.listProjectExecutions(projectId)
    return execs.map((e) => toExecution(e, projectId))
  }

  async listTasks(s: AdapterSession, filter?: {mine?: boolean}): Promise<Task[]> {
    const sess = this.need(s)
    const projects = await sess.client.listProjects()
    const out: Task[] = []
    await ZentaoClient.pooled(projects, 3, async (p) => {
      const execs = await sess.client.listProjectExecutions(p.id).catch(() => [])
      await ZentaoClient.pooled(execs, 4, async (e) => {
        try {
          const list = await sess.client.listExecutionTasks(e.id)
          for (const t of list) {
            if (t.parent !== 0) continue
            if (filter?.mine && t.assignedTo?.account !== sess.account) continue
            const task = toTask(t)
            task.projectName = p.name
            task.executionName = e.name
            out.push(task)
          }
        } catch {
          /* 单个执行失败不阻塞 */
        }
      })
    })
    return out
  }

  async getTask(s: AdapterSession, id: ID): Promise<Task> {
    return toTask(await this.need(s).client.getTask(id))
  }

  async listWorkers(s: AdapterSession): Promise<WorkerLite[]> {
    const users = await this.need(s).client.listUsers()
    return users.map((u) => ({account: u.account, realname: u.realname}))
  }

  // ---- 写（仅草案引擎调用）----

  async createTask(s: AdapterSession, input: TaskInput): Promise<{id: ID}> {
    const t = await this.need(s).client.createTask(input.executionId, {
      name: input.name,
      type: input.type ?? 'devel',
      pri: input.pri ?? 3,
      estimate: input.estimate ?? 0,
      assignedTo: input.assignedTo ?? [],
      // 禅道 21.7.9 要求必填预计开始
      estStarted: input.estStarted ?? new Date().toISOString().slice(0, 10),
      ...(input.deadline ? {deadline: input.deadline} : {}),
      ...(input.desc ? {desc: input.desc} : {}),
    })
    return {id: t.id}
  }

  async changeTaskStatus(
    s: AdapterSession,
    id: ID,
    action: StatusAction,
    body: {consumed?: number; left?: number; comment?: string} = {},
  ): Promise<void> {
    const payload: Record<string, unknown> = {}
    if (action === 'finish') {
      payload.consumed = body.consumed ?? 0
      payload.left = body.left ?? 0
      if (body.comment) payload.comment = body.comment
    }
    await this.need(s).client.taskAction(id, action, payload)
  }

  async logEffort(s: AdapterSession, taskId: ID, e: EffortEntry): Promise<void> {
    const sess = this.need(s)
    if (!sess.bridgeOk) throw new Error(sess.bridgeReason ?? '网页桥接未建立，无法记录工时')
    await sess.bridge.recordEstimate(taskId, {
      date: e.date ?? new Date().toISOString().slice(0, 10),
      consumed: e.consumed,
      left: e.left,
      work: e.work,
    })
  }

  async deleteTask(s: AdapterSession, id: ID): Promise<void> {
    const sess = this.need(s)
    if (!sess.bridgeOk) throw new Error(sess.bridgeReason ?? '网页桥接未建立，无法删除任务')
    await sess.bridge.deleteTask(id)
  }
}
