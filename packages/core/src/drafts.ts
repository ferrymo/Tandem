/**
 * 草案引擎（三段式）：propose（校验，不落库）→ review（人审/Agent 提请）→ execute（逐条落库）。
 * 人是唯一确认者；Agent 只能 propose。产品层与 MCP 共用此引擎。
 */
import type {CollabAdapter, EffortEntry, ID, StatusAction, TaskInput, AdapterSession} from './ports.js'

/** create_task 的入参沿用 TaskInput，另以 taskType 表达类型（Port 侧叫 type） */
export type CreateTaskAction = Omit<TaskInput, 'type'> & {type: 'create_task'; taskType?: string}

export type DraftAction =
  | CreateTaskAction
  | {type: 'update_task_status'; taskId: ID; action: StatusAction; consumed?: number; left?: number; comment?: string}
  | {type: 'log_effort'; taskId: ID; date?: string; consumed: number; left: number; work?: string}
  | {type: 'delete_task'; taskId: ID}

export type DraftSource = 'human' | 'agent' | 'ui'

export interface DraftCheck {
  index: number
  ok: boolean
  message: string
}

export interface DraftRecord {
  id: string
  source: DraftSource
  /** agent 来源时：agent id；人来源时：账号 */
  actor: string
  createdAt: number
  status: 'pending' | 'executed' | 'discarded'
  actions: DraftAction[]
  checks: DraftCheck[]
  results?: Array<{index: number; ok: boolean; message: string}>
}

export function describeAction(a: DraftAction): string {
  switch (a.type) {
    case 'create_task':
      return `创建任务「${a.name}」→ 执行 ${a.executionId}${a.assignedTo?.length ? `，指派 ${a.assignedTo.join('/')}` : ''}`
    case 'update_task_status':
      return `任务 #${a.taskId} 状态动作 ${a.action}${a.action === 'finish' ? `（耗 ${a.consumed ?? 0}h / 余 ${a.left ?? 0}h）` : ''}`
    case 'log_effort':
      return `任务 #${a.taskId} 登记 ${a.consumed}h（${a.date ?? '今天'}，完成后余 ${a.left}h）`
    case 'delete_task':
      return `删除任务 #${a.taskId}`
  }
}

/** 校验：只做确定性检查（引用存在性、必填项），不调用写接口 */
export async function checkActions(
  adapter: CollabAdapter,
  session: AdapterSession,
  actions: DraftAction[],
): Promise<DraftCheck[]> {
  const checks: DraftCheck[] = []
  // 缓存执行集合，避免逐条请求
  let execIds: Set<ID> | undefined
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    let issue: string | undefined
    try {
      if (a.type === 'create_task') {
        if (!execIds) {
          execIds = new Set<ID>()
          const projects = await adapter.listProjects(session)
          for (const p of projects) for (const e of await adapter.listExecutions(session, p.id)) execIds.add(e.id)
        }
        if (!execIds.has(a.executionId)) issue = `执行 ${a.executionId} 不存在或无权访问`
        if (!a.name?.trim()) issue = '任务名不能为空'
      } else if (a.type === 'update_task_status') {
        if (a.action === 'finish' && (!a.consumed || a.consumed <= 0)) issue = 'finish 需要 consumed > 0'
        if (a.action === 'finish' && a.left === undefined) issue = 'finish 需要 left（通常 0）'
        if (!issue) await adapter.getTask(session, a.taskId)
      } else if (a.type === 'log_effort') {
        if (!(a.consumed > 0)) issue = 'consumed 必须 > 0'
        if (a.left === undefined || a.left < 0) issue = 'left 必填且 >= 0'
        if (!issue) {
          const caps = await adapter.capabilities()
          if (!caps.logEffort) issue = caps.reason ? `记工时不可用：${caps.reason}` : '连接器不支持记工时'
        }
      } else if (a.type === 'delete_task') {
        const caps = await adapter.capabilities()
        if (!caps.deleteTask) issue = caps.reason ? `删除不可用：${caps.reason}` : '连接器不支持删除'
      }
    } catch (e) {
      issue = e instanceof Error ? e.message : String(e)
    }
    checks.push({index: i, ok: !issue, message: issue ?? describeAction(a)})
  }
  return checks
}

/** 执行单条动作（调用方逐条捕获异常，允许部分成功） */
export async function executeAction(
  adapter: CollabAdapter,
  session: AdapterSession,
  a: DraftAction,
): Promise<string> {
  switch (a.type) {
    case 'create_task': {
      const r = await adapter.createTask(session, {
        executionId: a.executionId,
        name: a.name,
        type: a.taskType,
        pri: a.pri,
        estimate: a.estimate,
        assignedTo: a.assignedTo,
        estStarted: a.estStarted ?? new Date().toISOString().slice(0, 10),
        deadline: a.deadline,
        desc: a.desc,
      })
      return `任务 #${r.id}「${a.name}」已创建`
    }
    case 'update_task_status':
      await adapter.changeTaskStatus(session, a.taskId, a.action, {
        consumed: a.consumed,
        left: a.left,
        comment: a.comment,
      })
      return `任务 #${a.taskId} 已执行 ${a.action}`
    case 'log_effort': {
      const entry: EffortEntry = {date: a.date, consumed: a.consumed, left: a.left, work: a.work}
      await adapter.logEffort(session, a.taskId, entry)
      return `任务 #${a.taskId} 已登记 ${a.consumed}h`
    }
    case 'delete_task':
      await adapter.deleteTask(session, a.taskId)
      return `任务 #${a.taskId} 已删除`
  }
}
