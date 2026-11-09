/**
 * Agent 工具集：把连接器端口包装成 LLM 可调用的函数。
 * 铁律：写操作只产出草案（propose），绝不直接落库——落库必须由人 execute。
 */
import type {CollabAdapter, AdapterSession, DraftAction, ID} from '@tandem/core'
import {checkActions, describeAction} from '@tandem/core'
import type {ToolSchema} from './llm.js'

export interface ToolContext {
  adapter: CollabAdapter
  session: AdapterSession
  /** 候选草案动作累积；run 结束时统一持久化 */
  pendingActions: DraftAction[]
}

export interface ToolResult {
  content: string
  /** 需要人工决策时，向 UI 暴露的选项 */
  decision?: {question: string; options: string[]}
}

export function toolSchemas(): ToolSchema[] {
  return [
    {
      name: 'list_projects',
      description: '列出我可见的全部项目（含状态、进度）',
      parameters: {type: 'object', properties: {}, required: []},
    },
    {
      name: 'list_executions',
      description: '列出某项目下的执行（迭代/阶段）。创建任务前必须先用它拿到 executionId',
      parameters: {
        type: 'object',
        properties: {projectId: {type: 'number', description: '项目 ID'}},
        required: ['projectId'],
      },
    },
    {
      name: 'list_tasks',
      description: '列出任务（可按项目/状态/指派人/关键词过滤，mine=只看自己）',
      parameters: {
        type: 'object',
        properties: {
          projectId: {type: 'number'},
          status: {type: 'string', description: '逗号分隔：wait,doing,done,closed,pause'},
          assignedTo: {type: 'string', description: '账号'},
          mine: {type: 'boolean'},
          keyword: {type: 'string'},
          limit: {type: 'number', description: '默认 30'},
        },
        required: [],
      },
    },
    {
      name: 'get_task',
      description: '查看单个任务详情',
      parameters: {type: 'object', properties: {taskId: {type: 'number'}}, required: ['taskId']},
    },
    {
      name: 'workload',
      description: '统计成员负载（任务数/预计/消耗/剩余），用于决定派给谁',
      parameters: {type: 'object', properties: {}, required: []},
    },
    {
      name: 'propose_tasks',
      description:
        '【写操作】批量提议创建任务（不会立即创建！只生成草案交人工确认）。创建前必须先用 list_executions 拿到有效 executionId',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                executionId: {type: 'number'},
                name: {type: 'string'},
                pri: {type: 'number', description: '1-4'},
                estimate: {type: 'number', description: '预计工时 h'},
                assignedTo: {type: 'array', items: {type: 'string'}, description: '账号数组'},
                deadline: {type: 'string', description: 'YYYY-MM-DD'},
                desc: {type: 'string'},
              },
              required: ['executionId', 'name'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'propose_status',
      description: '【写操作】提议变更任务状态（start/pause/restart/finish/close），生成草案待确认',
      parameters: {
        type: 'object',
        properties: {
          taskId: {type: 'number'},
          action: {type: 'string', enum: ['start', 'pause', 'restart', 'finish', 'close']},
          consumed: {type: 'number', description: 'finish 时的消耗工时'},
          left: {type: 'number', description: 'finish 时的剩余，通常 0'},
        },
        required: ['taskId', 'action'],
      },
    },
    {
      name: 'ask_human',
      description: '当需要人类做决定（方案选择/优先级/资源冲突）时调用，会暂停等待人类回答',
      parameters: {
        type: 'object',
        properties: {
          question: {type: 'string'},
          options: {type: 'array', items: {type: 'string'}, description: '候选答案'},
        },
        required: ['question'],
      },
    },
    {
      name: 'finish',
      description: '目标已达成或无法继续时调用，提交最终总结',
      parameters: {
        type: 'object',
        properties: {summary: {type: 'string', description: '给用户的结论/交付说明'}},
        required: ['summary'],
      },
    },
  ]
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function n(v: unknown): number | undefined {
  const x = Number(v)
  return Number.isFinite(x) ? x : undefined
}

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const {adapter, session} = ctx
  switch (name) {
    case 'list_projects': {
      const projects = await adapter.listProjects(session)
      return {content: JSON.stringify(projects.map((p) => ({id: p.id, name: p.name, status: p.status, progress: p.progress})))}
    }
    case 'list_executions': {
      const execs = await adapter.listExecutions(session, Number(args.projectId))
      return {content: JSON.stringify(execs.map((e) => ({id: e.id, name: e.name, status: e.status, begin: e.begin, end: e.end})))}
    }
    case 'list_tasks': {
      let tasks = await adapter.listTasks(session, {mine: Boolean(args.mine)})
      if (args.projectId) tasks = tasks.filter((t) => t.projectId === Number(args.projectId))
      if (args.status) {
        const st = s(args.status).split(',').map((x) => x.trim())
        tasks = tasks.filter((t) => st.includes(t.status))
      }
      if (args.assignedTo) tasks = tasks.filter((t) => t.assignedTo?.account === s(args.assignedTo))
      if (args.keyword) {
        const k = s(args.keyword).toLowerCase()
        tasks = tasks.filter((t) => t.name.toLowerCase().includes(k))
      }
      const limit = Math.min(n(args.limit) ?? 30, 100)
      return {
        content: JSON.stringify({
          total: tasks.length,
          tasks: tasks.slice(0, limit).map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            pri: t.pri,
            project: t.projectName,
            assignedTo: t.assignedTo?.account,
            left: t.left,
            deadline: t.deadline,
          })),
        }),
      }
    }
    case 'get_task': {
      const t = await adapter.getTask(session, Number(args.taskId))
      return {content: JSON.stringify(t)}
    }
    case 'workload': {
      const tasks = await adapter.listTasks(session)
      const m = new Map<string, {account: string; realname: string; count: number; left: number; consumed: number}>()
      for (const t of tasks) {
        if (t.status === 'cancel' || !t.assignedTo) continue
        const key = t.assignedTo.account
        const cur = m.get(key) ?? {account: key, realname: t.assignedTo.realname, count: 0, left: 0, consumed: 0}
        cur.count++
        cur.left += t.left
        cur.consumed += t.consumed
        m.set(key, cur)
      }
      const rows = [...m.values()].sort((a, b) => b.left - a.left)
      return {content: JSON.stringify(rows)}
    }
    case 'propose_tasks': {
      const list = Array.isArray(args.tasks) ? (args.tasks as Record<string, unknown>[]) : []
      if (list.length === 0) return {content: '没有任务可提议'}
      const actions: DraftAction[] = list.map((t) => ({
        type: 'create_task',
        executionId: Number(t.executionId),
        name: s(t.name),
        pri: n(t.pri) ?? 3,
        estimate: n(t.estimate) ?? 0,
        assignedTo: Array.isArray(t.assignedTo) ? (t.assignedTo as unknown[]).map(s) : undefined,
        deadline: t.deadline ? s(t.deadline) : undefined,
        desc: t.desc ? s(t.desc) : undefined,
        estStarted: new Date().toISOString().slice(0, 10),
      }))
      const checks = await checkActions(adapter, session, actions)
      const okCount = checks.filter((c) => c.ok).length
      ctx.pendingActions.push(...actions.filter((_, i) => checks[i].ok))
      const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.message}`)
      return {
        content: `${okCount}/${actions.length} 项通过校验，已加入草案（待人工确认后才会创建）：\n${lines.join('\n')}`,
      }
    }
    case 'propose_status': {
      const action: DraftAction = {
        type: 'update_task_status',
        taskId: Number(args.taskId),
        action: s(args.action) as 'start' | 'pause' | 'restart' | 'finish' | 'close',
        consumed: n(args.consumed),
        left: n(args.left),
      }
      const checks = await checkActions(adapter, session, [action])
      if (!checks[0].ok) return {content: `无法提议：${checks[0].message}`}
      ctx.pendingActions.push(action)
      return {content: `已加入草案：${describeAction(action)}`}
    }
    case 'ask_human': {
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(s) : []
      return {
        content: '已向人类发出决策请求，等待回答。',
        decision: {question: s(args.question), options},
      }
    }
    case 'finish':
      return {content: `任务结束：${s(args.summary)}`}
    default:
      return {content: `未知工具：${name}`}
  }
}

/** 需要人确认的写工具（用于系统提示中强调） */
export const WRITE_TOOLS = new Set(['propose_tasks', 'propose_status'])
