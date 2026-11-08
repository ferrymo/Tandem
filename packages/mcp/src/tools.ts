import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { executeAction, type DraftAction, type ZtState } from './state.js'

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}
function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `错误：${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  }
}

const num = (v: string | number | undefined | null): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** 把禅道任务压缩成模型友好的紧凑结构 */
function compactTask(t: Awaited<ReturnType<ZtState['taskById']>>) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    pri: t.pri,
    type: t.type,
    project: t.project,
    execution: t.execution,
    estimate: num(t.estimate),
    consumed: num(t.consumed),
    left: num(t.left),
    deadline: t.deadline || undefined,
    estStarted: t.estStarted || undefined,
    assignedTo: t.assignedTo?.account,
  }
}

export function registerReadTools(server: McpServer, s: ZtState) {
  server.tool('whoami', '查看当前登录的禅道账号信息', {}, async () => {
    try {
      const u = await s.client.getUser(s.account)
      return ok({ account: u.account, realname: u.realname, email: u.email, dept: u.dept, role: u.role })
    } catch (e) {
      return fail(e)
    }
  })

  server.tool(
    'list_projects',
    '列出我可见的全部项目（含状态、进度、任务数、执行数、延期数）',
    {},
    async () => {
      try {
        const projects = await s.projects()
        const data = await Promise.all(
          projects.map(async (p) => {
            const execs = await s.executions(p.id)
            return {
              id: p.id,
              name: p.name,
              status: p.status,
              progress: num(p.progress),
              begin: p.begin,
              end: p.end,
              executions: execs.length,
              tasksTotal: execs.reduce((a, e) => a + 0, 0) || undefined,
              delayedExecutions: execs.filter((e) => (e.delay ?? 0) > 0).length || undefined,
            }
          }),
        )
        return ok(data)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.tool('list_executions', '列出项目下的执行（迭代/阶段）', { projectId: z.number().int() }, async ({ projectId }) => {
    try {
      const execs = await s.executions(projectId)
      return ok(
        execs.map((e) => ({
          id: e.id,
          name: e.name,
          status: e.status,
          begin: e.begin,
          end: e.end,
          progress: num(e.progress),
          delay: e.delay ?? 0,
        })),
      )
    } catch (e) {
      return fail(e)
    }
  })

  server.tool(
    'list_tasks',
    '按条件列出任务（支持项目/执行/状态/指派人/关键词过滤，mine=1 只看自己）',
    {
      projectId: z.number().int().optional().describe('按项目过滤'),
      executionId: z.number().int().optional().describe('按执行过滤'),
      status: z.string().optional().describe('状态过滤，逗号分隔：wait,doing,done,closed,pause'),
      assignedTo: z.string().optional().describe('按指派人账号过滤'),
      mine: z.boolean().optional().describe('只看我被指派的'),
      keyword: z.string().optional().describe('任务名关键词'),
      limit: z.number().int().optional().describe('返回条数上限，默认 50'),
    },
    async (args) => {
      try {
        let tasks = await s.tasks()
        if (args.projectId) {
          tasks = tasks.filter((t) => t.project === args.projectId)
        }
        if (args.executionId) tasks = tasks.filter((t) => t.execution === args.executionId)
        if (args.status) {
          const st = args.status.split(',').map((x) => x.trim())
          tasks = tasks.filter((t) => st.includes(t.status))
        }
        if (args.assignedTo) tasks = tasks.filter((t) => t.assignedTo?.account === args.assignedTo)
        if (args.mine) tasks = tasks.filter((t) => t.assignedTo?.account === s.account)
        if (args.keyword) {
          const k = args.keyword.toLowerCase()
          tasks = tasks.filter((t) => t.name.toLowerCase().includes(k))
        }
        const limit = Math.min(args.limit ?? 50, 200)
        return ok({ total: tasks.length, tasks: tasks.slice(0, limit).map(compactTask) })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.tool('get_task', '查看单个任务详情（含描述）', { taskId: z.number().int() }, async ({ taskId }) => {
    try {
      const t = await s.taskById(taskId)
      return ok({
        ...compactTask(t),
        desc: (t.desc ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || undefined,
      })
    } catch (e) {
      return fail(e)
    }
  })

  server.tool(
    'workload',
    '统计成员负载（按活跃任务汇总：任务数/预计/消耗/剩余），支持按项目过滤。可见范围取决于当前账号权限',
    { projectId: z.number().int().optional() },
    async (args) => {
      try {
        let tasks = await s.tasks()
        if (args.projectId) tasks = tasks.filter((t) => t.project === args.projectId)
        tasks = tasks.filter((t) => !['cancel'].includes(t.status))
        const m = new Map<
          string,
          { account: string; realname: string; taskCount: number; estimate: number; consumed: number; left: number }
        >()
        for (const t of tasks) {
          const key = t.assignedTo?.account
          if (!key) continue
          const acc =
            m.get(key) ??
            { account: key, realname: t.assignedTo?.realname || key, taskCount: 0, estimate: 0, consumed: 0, left: 0 }
          acc.taskCount++
          acc.estimate += num(t.estimate)
          acc.consumed += num(t.consumed)
          acc.left += num(t.left)
          m.set(key, acc)
        }
        return ok([...m.values()].sort((a, b) => b.left - a.left))
      } catch (e) {
        return fail(e)
      }
    },
  )
}

/** 草稿动作的 zod schema（propose_changes 的 actions 数组元素） */
export const draftActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_task'),
    executionId: z.number().int().describe('目标执行 ID（用 list_executions 查询）'),
    name: z.string().min(1).describe('任务名称'),
    taskType: z.string().optional().describe('类型，默认 devel（devel/test/design/ops...）'),
    pri: z.number().int().min(1).max(4).optional().describe('优先级 1-4，默认 3'),
    estimate: z.number().optional().describe('预计工时(h)，默认 0'),
    assignedTo: z.array(z.string()).optional().describe('指派人账号数组'),
    estStarted: z.string().optional().describe('预计开始 YYYY-MM-DD'),
    deadline: z.string().optional().describe('截止 YYYY-MM-DD'),
    desc: z.string().optional().describe('任务描述'),
  }),
  z.object({
    type: z.literal('update_task_status'),
    taskId: z.number().int(),
    action: z.enum(['start', 'pause', 'restart', 'finish', 'close']),
    consumed: z.number().optional().describe('finish 必填：本次消耗工时(h)'),
    left: z.number().optional().describe('finish 必填：完成后剩余，通常 0'),
    comment: z.string().optional(),
  }),
  z.object({
    type: z.literal('log_effort'),
    taskId: z.number().int(),
    date: z.string().optional().describe('工时日期 YYYY-MM-DD，默认今天'),
    consumed: z.number().positive().describe('本次消耗工时(h)'),
    left: z.number().min(0).describe('完成后剩余工时(h)'),
    work: z.string().optional().describe('工作内容'),
  }),
  z.object({
    type: z.literal('create_project'),
    name: z.string().min(1),
    begin: z.string().optional().describe('开始日期 YYYY-MM-DD，默认今天'),
    end: z.string().optional().describe('结束日期 YYYY-MM-DD，默认今天'),
    parent: z.number().int().optional().describe('所属项目集 ID'),
  }),
])

function describeAction(a: DraftAction): string {
  switch (a.type) {
    case 'create_task':
      return `创建任务「${a.name}」→ 执行 ${a.executionId}${a.assignedTo?.length ? `，指派 ${a.assignedTo.join('/')}` : ''}`
    case 'update_task_status':
      return `任务 #${a.taskId} 状态动作 ${a.action}${a.action === 'finish' ? `（消耗 ${a.consumed ?? 0}h，剩余 ${a.left ?? 0}h）` : ''}`
    case 'log_effort':
      return `任务 #${a.taskId} 登记 ${a.consumed}h（${a.date ?? '今天'}，完成后剩余 ${a.left}h）`
    case 'create_project':
      return `创建项目「${a.name}」`
  }
}

export function registerDraftTools(server: McpServer, s: ZtState) {
  server.tool(
    'propose_changes',
    '【写操作入口】提交变更提案（创建任务/项目、任务状态流转、登记工时），生成草稿供人工审阅。不会立即执行！把返回的 draft_id 告知用户，待用户确认后调用 execute_changes',
    { actions: z.array(draftActionSchema).min(1).max(30).describe('变更动作列表') },
    async ({ actions }) => {
      try {
        const validation: Array<{ index: number; ok: boolean; message: string }> = []
        const projects = await s.projects().catch(() => [])
        const execIds = new Set<number>()
        for (const p of projects) for (const e of await s.executions(p.id)) execIds.add(e.id)

        for (let i = 0; i < actions.length; i++) {
          const a = actions[i] as DraftAction
          let msg = describeAction(a)
          let issue: string | undefined
          if (a.type === 'create_task') {
            if (!execIds.has(a.executionId)) issue = `执行 ${a.executionId} 不存在或不可见（用 list_executions 查询有效 ID）`
          } else if (a.type === 'update_task_status' && a.action === 'finish') {
            if (!(a.consumed && a.consumed > 0)) issue = 'finish 动作必须提供 consumed（>0）'
            else if (a.left === undefined) issue = 'finish 动作必须提供 left（通常 0）'
          } else if (a.type === 'log_effort') {
            if (!(a.consumed > 0)) issue = 'consumed 必须 > 0'
          } else if (a.type === 'create_project') {
            if (a.parent && !projects.some((p) => p.id === a.parent)) issue = `项目集 ${a.parent} 不存在或不可见`
          }
          if (issue) validation.push({ index: i, ok: false, message: issue })
          else validation.push({ index: i, ok: true, message: msg })
        }

        const draft = s.newDraft(actions, validation)
        const blocked = validation.filter((v) => !v.ok).length
        return ok({
          draftId: draft.id,
          status: blocked > 0 ? `有 ${blocked} 项校验未通过，修正后请重新 propose` : '待人工确认',
          plan: validation.map((v) => `${v.ok ? '✓' : '✗'} [${v.index}] ${v.ok ? v.message : v.message}`),
          next: '将草案内容展示给用户审阅；用户确认后调用 execute_changes(draftId)',
        })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.tool('get_draft', '查看草稿详情', { draftId: z.string() }, async ({ draftId }) => {
    const d = s.drafts.get(draftId)
    if (!d) return fail(new Error(`草稿 ${draftId} 不存在或已过期`))
    return ok(d)
  })

  server.tool(
    'execute_changes',
    '【人工确认后调用】执行草稿中的全部变更。调用前必须已获得用户的明确确认',
    { draftId: z.string() },
    async ({ draftId }) => {
      try {
        const d = s.drafts.get(draftId)
        if (!d) return fail(new Error(`草稿 ${draftId} 不存在或已过期`))
        if (d.status !== 'pending') return fail(new Error(`草稿 ${draftId} 状态为 ${d.status}，不能执行`))
        if (d.validation.some((v) => !v.ok)) return fail(new Error('草案存在校验未通过项，请修正后重新 propose'))

        const results: Array<{ index: number; type: string; ok: boolean; message: string }> = []
        for (let i = 0; i < d.actions.length; i++) {
          try {
            const msg = await executeAction(s, d.actions[i])
            results.push({ index: i, type: d.actions[i].type, ok: true, message: msg })
          } catch (e) {
            results.push({ index: i, type: d.actions[i].type, ok: false, message: e instanceof Error ? e.message : String(e) })
          }
        }
        d.status = 'executed'
        d.results = results
        s.dropCaches()
        const okCount = results.filter((r) => r.ok).length
        return ok({
          summary: `${okCount}/${results.length} 项执行成功`,
          results: results.map((r) => `${r.ok ? '✓' : '✗'} [${r.index}] ${r.message}`),
        })
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.tool('discard_draft', '放弃草稿', { draftId: z.string() }, async ({ draftId }) => {
    const d = s.drafts.get(draftId)
    if (!d) return fail(new Error(`草稿 ${draftId} 不存在或已过期`))
    d.status = 'discarded'
    return ok({ draftId, status: 'discarded' })
  })
}
