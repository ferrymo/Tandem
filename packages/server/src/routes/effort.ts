import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PasswordChangeRequiredError } from '@ztp/zentao-sdk'
import { config } from '../config.js'
import { getTasks } from './tasks.js'
import type { Session } from '../sessions.js'

const LOG_FILE = resolve(config.dataDir, 'effort-log.jsonl')

interface LogEntry {
  account: string
  realname: string
  date: string
  taskId: number
  taskName: string
  projectName: string
  executionName?: string
  consumed: number
  left?: number
  work?: string
  consumedAfter?: number
  submittedAt: number
}

function readLog(): LogEntry[] {
  if (!existsSync(LOG_FILE)) return []
  const out: LogEntry[] = []
  for (const line of readFileSync(LOG_FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

function sumBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Array<{key: string; total: number}> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r))
  return [...m.entries()].map(([key, total]) => ({key, total})).sort((a, b) => b.total - a.total)
}

export async function effortRoutes(app: FastifyInstance) {
  mkdirSync(config.dataDir, {recursive: true})

  /** 我的待填工时任务：跨项目、状态为 wait/doing/pause 且指派给我的任务 */
  app.get('/api/effort/tasks', async (req) => {
    const all = await getTasks(req.session)
    const me = req.session.account
    const rows = all
      .filter((t) => t.assignedTo?.account === me && ['wait', 'doing', 'pause'].includes(t.status))
      .sort((a, b) => a.projectId - b.projectId || a.pri - b.pri)
    return {tasks: rows}
  })

  /** 批量记工时：先写禅道（网页桥接），再回读任务校验，并落本地日志供视图使用 */
  app.post('/api/effort/submit', async (req, reply) => {
    const s = req.session
    const {date, entries} = (req.body ?? {}) as {
      date?: string
      entries?: Array<{taskId: number; consumed: number; left?: number; work?: string}>
    }
    if (!date || !Array.isArray(entries) || entries.length === 0) {
      return reply.code(400).send({message: 'date 与 entries 必填'})
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({message: 'date 格式应为 YYYY-MM-DD'})

    // 确保网页桥接可用（不可用则用会话内密码重试一次）
    if (!s.bridgeOk || s.passwordChangeRequired) {
      try {
        await s.bridge.login(s.account, s.password)
        s.bridgeOk = true
        s.passwordChangeRequired = false
      } catch (e) {
        if (e instanceof PasswordChangeRequiredError) {
          return reply.code(409).send({
            code: 'PASSWORD_CHANGE_REQUIRED',
            message: '禅道要求先修改密码，暂时无法记录工时。请登录禅道网页修改密码后重试。',
          })
        }
        return reply.code(502).send({code: 'BRIDGE_ERROR', message: `网页会话建立失败：${(e as Error).message}`})
      }
    }

    const all = await getTasks(s)
    const taskInfo = new Map(all.map((t) => [t.id, t]))
    const results: Array<{taskId: number; ok: boolean; consumedAfter?: number; error?: string}> = []

    for (const e of entries) {
      const info = taskInfo.get(e.taskId)
      try {
        await s.bridge.recordEstimate(e.taskId, {
          date,
          consumed: e.consumed,
          left: e.left ?? info?.left ?? 0,
          work: e.work,
        })
        const after = await s.client.getTask(e.taskId)
        results.push({taskId: e.taskId, ok: true, consumedAfter: Number(after.consumed)})
        appendFileSync(
          LOG_FILE,
          JSON.stringify({
            account: s.account,
            realname: s.realname,
            date,
            taskId: e.taskId,
            taskName: info?.name ?? '',
            projectName: info?.projectName ?? '',
            executionName: info?.executionName,
            consumed: e.consumed,
            left: e.left,
            work: e.work,
            consumedAfter: Number(after.consumed),
            submittedAt: Date.now(),
          }) + '\n',
        )
      } catch (err) {
        if (err instanceof PasswordChangeRequiredError) {
          s.passwordChangeRequired = true
          return reply.code(409).send({
            code: 'PASSWORD_CHANGE_REQUIRED',
            message: '禅道要求先修改密码，暂时无法记录工时。请登录禅道网页修改密码后重试。',
          })
        }
        results.push({taskId: e.taskId, ok: false, error: (err as Error).message})
      }
    }
    getTasks.drop(s) // 任务累计工时已变化，失效缓存
    return {results}
  })

  /** 我的工时记录（来自本工具提交日志） */
  app.get('/api/effort/mine', async (req) => {
    const {from, to} = req.query as {from?: string; to?: string}
    const rows = readLog().filter((r) => r.account === req.session.account && inRange(r.date, from, to))
    return {
      total: Math.round(rows.reduce((a, r) => a + r.consumed, 0) * 100) / 100,
      byDate: sumBy(rows, (r) => r.date, (r) => r.consumed),
      byProject: sumBy(rows, (r) => r.projectName || '(未知项目)', (r) => r.consumed),
      items: rows.sort((a, b) => b.date.localeCompare(a.date) || b.submittedAt - a.submittedAt).slice(0, 200),
    }
  })

  /** 团队工时记录（仅 ZT_LEAD_ACCOUNTS） */
  app.get('/api/effort/team', async (req, reply) => {
    if (!config.leadAccounts.has(req.session.account)) {
      return reply.code(403).send({message: '仅交付负责人可查看团队工时'})
    }
    const {from, to} = req.query as {from?: string; to?: string}
    const rows = readLog().filter((r) => inRange(r.date, from, to))
    const byAccountMap = new Map<string, {account: string; realname: string; total: number}>()
    for (const r of rows) {
      const acc = byAccountMap.get(r.account) ?? {account: r.account, realname: r.realname || r.account, total: 0}
      acc.total += r.consumed
      byAccountMap.set(r.account, acc)
    }
    return {
      total: Math.round(rows.reduce((a, r) => a + r.consumed, 0) * 100) / 100,
      byAccount: [...byAccountMap.values()].sort((a, b) => b.total - a.total),
      byProject: sumBy(rows, (r) => r.projectName || '(未知项目)', (r) => r.consumed),
      byDate: sumBy(rows, (r) => r.date, (r) => r.consumed).sort((a, b) => a.key.localeCompare(b.key)),
      items: rows.sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 300),
      meta: '数据来源：通过本工具提交的工时记录；接入禅道数据库后可展示全量历史工时',
    }
  })

  /** 任务工时累计汇总（来自禅道 API，天然全量）：按项目 / 按人（负责人可见按人） */
  app.get('/api/effort/summary', async (req) => {
    const tasks = await getTasks(req.session)
    const isLead = config.leadAccounts.has(req.session.account)
    const active = tasks.filter((t) => !['cancel'].includes(t.status))
    const byProjectMap = new Map<number, {projectId: number; projectName: string; estimate: number; consumed: number; left: number; taskCount: number}>()
    for (const t of active) {
      const acc = byProjectMap.get(t.projectId) ?? {projectId: t.projectId, projectName: t.projectName, estimate: 0, consumed: 0, left: 0, taskCount: 0}
      acc.estimate += t.estimate
      acc.consumed += t.consumed
      acc.left += t.left
      acc.taskCount += 1
      byProjectMap.set(t.projectId, acc)
    }
    const byProject = [...byProjectMap.values()].sort((a, b) => b.consumed - a.consumed)

    let byPerson: Array<{account: string; realname: string; estimate: number; consumed: number; left: number; taskCount: number}> = []
    if (isLead) {
      const m = new Map<string, {account: string; realname: string; estimate: number; consumed: number; left: number; taskCount: number}>()
      for (const t of active.filter((x) => !['done', 'closed'].includes(x.status) || x.consumed > 0)) {
        const key = t.assignedTo?.account
        if (!key) continue
        const acc = m.get(key) ?? {account: key, realname: t.assignedTo?.realname || key, estimate: 0, consumed: 0, left: 0, taskCount: 0}
        acc.estimate += t.estimate
        acc.consumed += t.consumed
        acc.left += t.left
        acc.taskCount += 1
        m.set(key, acc)
      }
      byPerson = [...m.values()].sort((a, b) => b.left - a.left)
    }
    return {byProject, byPerson}
  })
}
