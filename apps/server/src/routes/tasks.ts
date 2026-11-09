import { ZentaoClient, type ZtTask } from '@tandem/adapter-zentao'
import type { FastifyInstance } from 'fastify'
import { ttlKeyed } from '../cache.js'
import { getOverview } from './overview.js'
import type { Session } from '../sessions.js'

export interface TaskDto {
  id: number
  name: string
  status: string
  pri: number
  type: string
  estimate: number
  consumed: number
  left: number
  deadline: string
  estStarted: string
  assignedTo: {account: string; realname: string} | null
  projectId: number
  projectName: string
  executionId: number
  executionName: string
}

const num = (v: string | number | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function toDto(t: ZtTask, project: {id: number; name: string}, execution: {id: number; name: string}): TaskDto {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    pri: t.pri,
    type: t.type,
    estimate: num(t.estimate),
    consumed: num(t.consumed),
    left: num(t.left),
    deadline: t.deadline ?? '',
    estStarted: t.estStarted ?? '',
    assignedTo: t.assignedTo ? {account: t.assignedTo.account, realname: t.assignedTo.realname} : null,
    projectId: project.id,
    projectName: project.name,
    executionId: execution.id,
    executionName: execution.name,
  }
}

/** 全量任务缓存：按账号 5 分钟。任务状态变更后请 drop 对应账号缓存 */
export const getTasks = ttlKeyed(async (s: Session): Promise<TaskDto[]> => {
  const ov = await getOverview(s)
  const client = s.client
  const all: TaskDto[] = []
  const projectInfo = new Map(ov.projects.map((p) => [p.id, p]))
  await ZentaoClient.pooled(ov.projects, 3, async (p) => {
    await ZentaoClient.pooled(p.executions, 4, async (e) => {
      try {
        const tasks = await client.listExecutionTasks(e.id)
        const proj = {id: p.id, name: p.name}
        const exec = {id: e.id, name: e.name}
        for (const t of tasks) {
          const dto = toDto(t, proj, exec)
          // 父任务（多子任务容器）在看板里是噪声，过滤掉；子任务会自然出现
          if (t.parent === 0) all.push(dto)
          else if (projectInfo.get(t.project)?.executions.length === 0) all.push(dto)
        }
      } catch {
        /* 单个执行拉取失败不阻塞整体 */
      }
    })
  })
  return all
}, 5 * 60 * 1000)

export async function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (req) => {
    const q = req.query as {
      project?: string
      execution?: string
      status?: string
      assignedTo?: string
      mine?: string
      q?: string
      limit?: string
    }
    let tasks = await getTasks(req.session)
    if (q.project) {
      const ids = q.project.split(',').map(Number)
      tasks = tasks.filter((t) => ids.includes(t.projectId))
    }
    if (q.execution) tasks = tasks.filter((t) => t.executionId === Number(q.execution))
    if (q.status) {
      const st = q.status.split(',')
      tasks = tasks.filter((t) => st.includes(t.status))
    }
    if (q.assignedTo) tasks = tasks.filter((t) => t.assignedTo?.account === q.assignedTo)
    if (q.mine === '1') tasks = tasks.filter((t) => t.assignedTo?.account === req.session.account)
    if (q.q) {
      const kw = q.q.toLowerCase()
      tasks = tasks.filter((t) => t.name.toLowerCase().includes(kw) || t.projectName.toLowerCase().includes(kw))
    }
    const limit = Math.min(Number(q.limit ?? 1000), 2000)
    return {total: tasks.length, tasks: tasks.slice(0, limit)}
  })

  app.get('/api/board', async (req) => {
    const q = req.query as {project?: string; assignedTo?: string; mine?: string; q?: string}
    let tasks = await getTasks(req.session)
    if (q.project) {
      const ids = q.project.split(',').map(Number)
      tasks = tasks.filter((t) => ids.includes(t.projectId))
    }
    if (q.assignedTo) tasks = tasks.filter((t) => t.assignedTo?.account === q.assignedTo)
    if (q.mine === '1') tasks = tasks.filter((t) => t.assignedTo?.account === req.session.account)
    if (q.q) {
      const kw = q.q.toLowerCase()
      tasks = tasks.filter((t) => t.name.toLowerCase().includes(kw))
    }
    const groups: Record<string, TaskDto[]> = {wait: [], doing: [], done: [], closed: [], other: []}
    for (const t of tasks) {
      ;(groups[t.status] ?? groups.other).push(t)
    }
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => a.pri - b.pri || a.id - b.id)
    return groups
  })

  /** 任务状态流转：start/pause/restart/finish/close；finish 需带 consumed(+left) */
  app.post('/api/tasks/:id/action', async (req) => {
    const {id} = req.params as {id: string}
    const {action, consumed, left, comment} = (req.body ?? {}) as {
      action?: string
      consumed?: number
      left?: number
      comment?: string
    }
    const actions = ['start', 'pause', 'restart', 'finish', 'close'] as const
    if (!actions.includes(action as (typeof actions)[number])) {
      throw Object.assign(new Error(`不支持的动作: ${action}`), {statusCode: 400})
    }
    const body: Record<string, unknown> = {}
    if (action === 'finish') {
      body.consumed = consumed ?? 0
      body.left = left ?? 0
      if (comment) body.comment = comment
    }
    await req.session.client.taskAction(Number(id), action as (typeof actions)[number], body)
    getTasks.drop(req.session)
    const task = await req.session.client.getTask(Number(id))
    return {ok: true, task}
  })

  app.get('/api/users', async (req) => {
    const users = await req.session.client.listUsers()
    return users.map((u) => ({account: u.account, realname: u.realname, dept: u.dept}))
  })
}
