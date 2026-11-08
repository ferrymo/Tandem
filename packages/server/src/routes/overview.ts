import { ZentaoClient, type ZtProgram } from '@ztp/zentao-sdk'
import type { FastifyInstance } from 'fastify'
import { ttlKeyed } from '../cache.js'
import type { Session } from '../sessions.js'

export interface ExecutionDto {
  id: number
  name: string
  status: string
  type: string
  begin: string
  end: string
  progress: number
  delay: number
  tasksTotal: number
}

export interface ProjectDto {
  id: number
  name: string
  code: string
  status: string
  begin: string
  end: string
  progress: number
  programId: number
  executions: ExecutionDto[]
  tasksTotal: number
  doingExecutions: number
  delayedExecutions: number
}

export interface OverviewDto {
  programs: Array<{id: number; name: string}>
  projects: ProjectDto[]
  generatedAt: number
}

const num = (v: string | number | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

async function buildOverview(s: Session): Promise<OverviewDto> {
  const client = s.client
  const [programsResp, projects] = await Promise.all([client.listPrograms().catch(() => ({programs: [] as ZtProgram[]})), client.listProjects()])
  const programName = new Map(programsResp.programs.map((p) => [p.id, p.name]))

  const withExecs = await client.fetchProjectsWithExecutions()

  const projectDtos = await ZentaoClient.pooled(withExecs, 3, async (p) => {
    const executions = await ZentaoClient.pooled(p.executions, 4, async (e): Promise<ExecutionDto> => {
      let tasksTotal = 0
      try {
        const head = await client.get<{total: number}>(`executions/${e.id}/tasks`, {limit: 1})
        tasksTotal = head.total ?? 0
      } catch {
        /* 计数失败按 0 处理 */
      }
      return {
        id: e.id,
        name: e.name,
        status: e.status,
        type: e.type,
        begin: e.begin,
        end: e.end,
        progress: num(e.progress),
        delay: e.delay ?? 0,
        tasksTotal,
      }
    })
    const active = executions.filter((e) => e.tasksTotal > 0)
    const weighted = active.length
      ? active.reduce((acc, e) => acc + e.progress * e.tasksTotal, 0) / active.reduce((acc, e) => acc + e.tasksTotal, 0)
      : num(p.progress)
    return {
      id: p.id,
      name: p.name,
      code: p.code,
      status: p.status,
      begin: p.begin,
      end: p.end,
      progress: Math.round(weighted * 10) / 10,
      programId: p.parent,
      executions,
      tasksTotal: executions.reduce((a, e) => a + e.tasksTotal, 0),
      doingExecutions: executions.filter((e) => e.status === 'doing').length,
      delayedExecutions: executions.filter((e) => e.delay > 0).length,
    }
  })

  projectDtos.sort((a, b) => a.id - b.id)
  return {
    // 禅道 /programs 会返回整棵项目树，指挥台的项目集筛选只保留顶级项目集
    programs: programsResp.programs.filter((p) => !p.parent).map((p) => ({id: p.id, name: p.name})),
    projects: projectDtos,
    generatedAt: Date.now(),
  }
}

/** 指挥台聚合数据（按账号缓存 2 分钟；执行任务计数首次构建约需数十次禅道请求） */
export const getOverview = ttlKeyed(buildOverview, 2 * 60 * 1000)

export async function overviewRoutes(app: FastifyInstance) {
  app.get('/api/overview', async (req) => getOverview(req.session))
}
