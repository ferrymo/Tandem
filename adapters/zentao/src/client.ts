import {
  PasswordChangeRequiredError,
  ZentaoError,
  type ZtExecution,
  type ZtProgram,
  type ZtProject,
  type ZtTask,
  type ZtUser,
} from './types.js'

export interface ZentaoClientOptions {
  baseUrl: string
  token: string
}

function joinUrl(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).filter(Boolean).join('/')
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/**
 * 禅道 REST API v1 客户端（实测于禅道 21.7.9）。
 * 认证：POST /api.php/v1/tokens 获取 token，后续请求带 `Token: <token>` 头。
 */
export class ZentaoClient {
  readonly baseUrl: string
  readonly token: string

  constructor(opts: ZentaoClientOptions) {
    // 允许传入裸域名或已带 /api.php/v1 的地址，统一收敛为裸域名
    this.baseUrl = opts.baseUrl.replace(/\/api\.php\/v1\/?$/, '').replace(/\/+$/, '')
    this.token = opts.token
  }

  /** 用账号密码换取 token 并构建客户端 */
  static async login(baseUrl: string, account: string, password: string): Promise<ZentaoClient> {
    const root = baseUrl.replace(/\/api\.php\/v1\/?$/, '').replace(/\/+$/, '')
    const res = await fetch(joinUrl(root, 'api.php/v1/tokens'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password }),
    })
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = (body as {error?: string} | undefined)?.error
      throw new ZentaoError(res.status, msg || `禅道登录失败(${res.status})，请检查账号密码`, body)
    }
    const data = (await res.json()) as { token: string }
    return new ZentaoClient({ baseUrl: root, token: data.token })
  }

  private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(joinUrl(this.baseUrl, 'api.php/v1', path))
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, {
      method,
      headers: { Token: this.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401) throw new ZentaoError(401, '禅道会话已过期，请重新登录')
    if (!res.ok) {
      const errBody = await safeJson(res)
      const msg = (errBody as {error?: string} | undefined)?.error
      throw new ZentaoError(res.status, msg || `禅道API错误 ${res.status}`, errBody)
    }
    return (await res.json()) as T
  }

  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, params)
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body)
  }

  /**
   * 拉取列表资源并自动翻页聚合。
   * 禅道 v1 列表返回 {page,total,limit,<listKey>:[...]}；programs 等个别接口无分页包装，直接返回 {<listKey>:[...]}。
   */
  async collect<T>(path: string, listKey: string, params: Record<string, string | number | undefined> = {}, maxItems = 5000): Promise<T[]> {
    const out: T[] = []
    let page = 1
    for (;;) {
      const body = await this.get<Record<string, unknown>>(path, { ...params, page, limit: params.limit ?? 100 })
      const arr = (body[listKey] ?? []) as T[]
      out.push(...arr)
      const total = typeof body.total === 'number' ? body.total : out.length
      if (!Array.isArray(arr) || arr.length === 0 || out.length >= total || out.length >= maxItems) break
      page++
    }
    return out
  }

  // ---------- 领域方法 ----------

  listPrograms(): Promise<{ programs: ZtProgram[] }> {
    return this.get('programs')
  }

  listProjects(): Promise<ZtProject[]> {
    return this.collect<ZtProject>('projects', 'projects')
  }

  listProjectExecutions(projectId: number): Promise<ZtExecution[]> {
    return this.collect<ZtExecution>(`projects/${projectId}/executions`, 'executions')
  }

  listExecutionTasks(executionId: number): Promise<ZtTask[]> {
    return this.collect<ZtTask>(`executions/${executionId}/tasks`, 'tasks')
  }

  listUsers(): Promise<ZtUser[]> {
    return this.collect<ZtUser>('users', 'users')
  }

  getUser(account: string): Promise<ZtUser> {
    return this.get(`users/${account}`)
  }

  getTask(id: number): Promise<ZtTask> {
    return this.get(`tasks/${id}`)
  }

  createTask(executionId: number, body: Record<string, unknown>): Promise<ZtTask> {
    return this.post(`executions/${executionId}/tasks`, body)
  }

  editTask(id: number, body: Record<string, unknown>): Promise<ZtTask> {
    return this.put(`tasks/${id}`, body)
  }

  /** 任务状态动作：start / pause / restart / finish / close，finish 需带 consumed/left */
  taskAction(id: number, action: 'start' | 'pause' | 'restart' | 'finish' | 'close', body: Record<string, unknown> = {}): Promise<unknown> {
    return this.post(`tasks/${id}/${action}`, body)
  }

  // ---------- 聚合辅助 ----------

  /** 并发受限的 map，避免对禅道瞬间打满连接 */
  static async pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let next = 0
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) break
        results[i] = await fn(items[i])
      }
    })
    await Promise.all(workers)
    return results
  }

  /** 拉取可见全部项目 + 各项目执行列表（指挥台数据底座，3~N 次请求） */
  async fetchProjectsWithExecutions(): Promise<Array<ZtProject & {executions: ZtExecution[]}>> {
    const projects = await this.listProjects()
    return ZentaoClient.pooled(projects, 6, async (p) => ({
      ...p,
      executions: await this.listProjectExecutions(p.id),
    }))
  }
}

export { PasswordChangeRequiredError }
