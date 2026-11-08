/**
 * 禅道网页会话桥接：REST v1 覆盖不到的操作（记工时、任务删除）经由网页会话提交。
 * 实测：禅道 21.7.9 登录表单为明文密码 POST（HTTPS 下），无验证码、无 CSRF token。
 * 已知拦截：开启强制改密策略时所有页面重定向到 changePassword，此时抛 PasswordChangeRequiredError。
 */

import {createHash} from 'node:crypto'

import { PasswordChangeRequiredError, ZentaoError } from './types.js'

export interface BridgeResponse {
  status: number
  finalUrl: string
  body: string
}

export interface ParsedForm {
  action: string
  fields: Map<string, string>
  /** 表单所在页面的完整 HTML（部分字段可能位于 </form> 之外，如 verifyRand） */
  html: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? decodeEntities(m[1]) : undefined
}

export class WebBridge {
  private cookie = new Map<string, string>()
  private loggedIn = false

  constructor(readonly baseUrl: string) {}

  private cookieHeader(): string {
    return [...this.cookie.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private captureCookies(res: Response) {
    const raw = res.headers.getSetCookie?.() ?? []
    for (const line of raw) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const k = pair.slice(0, eq).trim()
        const v = pair.slice(eq + 1).trim()
        if (v === 'deleted' || v === '') this.cookie.delete(k)
        else this.cookie.set(k, v)
      }
    }
  }

  private async raw(path: string, init?: RequestInit & {referer?: string}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`
    return fetch(url, {
      ...init,
      redirect: 'manual',
      headers: {
        Cookie: this.cookieHeader(),
        'User-Agent': 'zentaopro-bridge/0.1',
        ...(init?.referer ? {Referer: init.referer} : {}),
        ...(init?.headers ?? {}),
      },
    })
  }

  /** 手动跟随重定向（沿途吸收 set-cookie），最多 5 跳 */
  private async request(path: string, init?: RequestInit & {referer?: string}): Promise<BridgeResponse> {
    let url = path.startsWith('http') ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`
    let referer = init?.referer
    for (let i = 0; i < 6; i++) {
      const res = await this.raw(url, {...init, referer})
      this.captureCookies(res)
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        referer = url
        url = new URL(loc, url).toString()
        init = {...init, method: 'GET', body: undefined}
        continue
      }
      const body = await res.text()
      return {status: res.status, finalUrl: url, body}
    }
    throw new ZentaoError(508, '禅道网页重定向次数过多')
  }

  /** 仅建立会话（不做改密校验），供 login 与 changePassword 复用 */
  async authenticate(account: string, password: string): Promise<void> {
    this.cookie.clear()
    const loginUrl = 'index.php?m=user&f=login'
    await this.request(loginUrl) // 预取，建立 zentaosid
    await this.request(loginUrl, {
      method: 'POST',
      referer: `${this.baseUrl}/${loginUrl}`,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({account, password, keepLogin: 'on'}).toString(),
    })
    this.loggedIn = this.cookie.has('zentaosid')
  }

  /** 账号密码建立网页会话，并校验未被强制改密拦截 */
  async login(account: string, password: string): Promise<void> {
    await this.authenticate(account, password)
    // 校验会话：访问我的地盘
    const my = await this.request('index.php?m=my&f=index')
    if (my.finalUrl.includes('changePassword')) {
      throw new PasswordChangeRequiredError()
    }
    if (my.body.includes('id="loginForm"') || my.finalUrl.includes('user-login')) {
      throw new ZentaoError(401, '网页登录失败：账号或密码错误（或需要验证码）')
    }
  }

  /**
   * 修改密码（走 m=my&f=changePassword 表单）。
   * 哈希规则取自页面内联脚本：originalPassword=md5(md5(明文)+rand)，password1/2=md5(明文)+rand。
   */
  async changePassword(account: string, original: string, next: string): Promise<void> {
    if (!this.loggedIn) await this.authenticate(account, original)
    const formPath = 'index.php?m=my&f=changePassword'
    const res = await this.request(formPath)
    if (!res.finalUrl.includes('changePassword')) {
      throw new ZentaoError(400, '未进入改密页面，当前账号可能无需修改密码')
    }
    const form = await this.parsePostedForm(res.body, res.finalUrl, 'password1')
    // verifyRand 输入框位于 </form> 之外，需从整页提取后附加到提交
    const rand =
      form.fields.get('verifyRand') ??
      res.body.match(/name=["']verifyRand["'][^>]*value=["']([^"']*)["']/)?.[1] ??
      ''
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    // 复刻禅道前端 computePasswordStrength，等级取值 1/2/3（弱/中/强）
    const score =
      Number(next.length >= 6) +
      Number(/[a-z]/.test(next) && /[A-Z]/.test(next)) +
      Number(/\d/.test(next)) +
      Number(/[^a-zA-Z0-9]/.test(next))
    const strength = Math.min(Math.max(score, 1), 3)
    const payload = new URLSearchParams()
    for (const [k, v] of form.fields) {
      if (k === 'originalPassword') payload.set(k, md5(md5(original) + rand))
      else if (k === 'password1') payload.set(k, md5(next) + rand)
      else if (k === 'password2') payload.set(k, md5(next) + rand)
      else if (k === 'passwordLength') payload.set(k, String(next.length))
      else payload.set(k, v)
    }
    if (rand) payload.set('verifyRand', rand)
    // 表单里没有该输入框，但服务端依赖它判定密码强度（缺失视为 0 → 必然被拒）
    payload.set('passwordStrength', String(Math.max(strength, 1)))
    const postRes = await this.request(form.action, {
      method: 'POST',
      referer: `${this.baseUrl}/${formPath}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: payload.toString(),
    })
    // ajaxForm 提交返回 JSON：result=fail 时透出服务端真实原因
    try {
      const data = JSON.parse(postRes.body) as {result?: string; message?: unknown; load?: string}
      if (data.result === 'fail') {
        const msg = typeof data.message === 'string' ? data.message : JSON.stringify(data.message)
        throw new ZentaoError(422, `修改密码被禅道拒绝：${msg}`)
      }
    } catch (e) {
      if (e instanceof ZentaoError) throw e
      /* 非 JSON 响应（普通跳转流程），继续用会话探测判断 */
    }
    // 复核：若仍被重定向到改密页，说明未生效（新密码不满足策略或与原密码相同被拒）
    const probe = await this.request('index.php?m=my&f=index')
    if (probe.finalUrl.includes('changePassword')) {
      throw new ZentaoError(
        422,
        '修改密码未生效：禅道拒绝了该新密码（可能与原密码相同或强度不足），请在禅道网页手动修改',
      )
    }
  }

  async ensureLogin(account: string, password: string): Promise<void> {
    if (!this.loggedIn) await this.login(account, password)
  }

  /** 拉取页面并解析其 POST 表单（同 fetchForm，但额外携带页面 HTML 与公开访问） */
  async getForm(path: string, markerField?: string): Promise<ParsedForm> {
    return this.fetchForm(path, markerField, {allowChangePasswordPage: true})
  }

  /** 拉取并解析页面上的 POST 表单（默认取含 marker 字段的表单，否则第一个表单） */
  async fetchForm(
    path: string,
    markerField?: string,
    opts?: {allowChangePasswordPage?: boolean},
  ): Promise<ParsedForm> {
    const res = await this.request(path)
    if (!opts?.allowChangePasswordPage && res.finalUrl.includes('changePassword')) {
      throw new PasswordChangeRequiredError()
    }
    return this.parsePostedForm(res.body, res.finalUrl, markerField, path)
  }

  private parsePostedForm(html: string, baseUrl: string, markerField?: string, fallbackPath = ''): ParsedForm {
    const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? []
    const candidates = forms.filter((f) => /method\s*=\s*["']post["']/i.test(f))
    const formHtml =
      candidates.find((f) => (markerField ? new RegExp(`name=["']${markerField}["']`).test(f) : true)) ?? candidates[0]
    if (!formHtml) throw new ZentaoError(404, `页面无可用表单: ${fallbackPath || '(未知路径)'}`)
    const formTag = formHtml.match(/<form\b[^>]*>/i)![0]
    const actionRaw = attr(formTag, 'action') ?? ''
    const action = new URL(actionRaw || fallbackPath, baseUrl).toString()

    const fields = new Map<string, string>()
    for (const input of formHtml.match(/<input\b[^>]*>/gi) ?? []) {
      const name = attr(input, 'name')
      if (!name) continue
      const type = (attr(input, 'type') ?? 'text').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'file') continue
      // 单选/复选：只保留勾选中的项，避免同名多值被最后一个覆盖
      if ((type === 'radio' || type === 'checkbox') && !/\bchecked\b/i.test(input)) continue
      fields.set(name, attr(input, 'value') ?? '')
    }
    for (const m of formHtml.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
      const opts = [...m[2].matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>/gi)]
      const selected = [...m[2].matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*selected/gi)]
      fields.set(m[1], selected[0]?.[1] ?? opts[0]?.[1] ?? '')
    }
    for (const m of formHtml.matchAll(/<textarea\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi)) {
      fields.set(m[1], decodeEntities(m[2].trim()))
    }
    return {action, fields, html}
  }

  /** 通用表单提交（XHR，返回原始响应文本供调用方解析 JSON） */
  async submitForm(
    action: string,
    data: Record<string, string>,
    referer?: string,
  ): Promise<{status: number; body: string}> {
    const res = await this.request(action, {
      method: 'POST',
      referer: referer ?? action,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams(data).toString(),
    })
    return {status: res.status, body: res.body}
  }

  /**
   * 记录任务工时（禅道「记录工时」表单）。
   * 21.7.9 实测：入口为 task-recordWorkhour（旧版 task-recordEstimate 做兼容探测），
   * 该表单是批量表格（form-batch），字段须按数组提交：date[]/work[]/consumed[]/left[]。
   */
  async recordEstimate(
    taskId: number,
    input: {date?: string; consumed: number; left: number; work?: string},
  ): Promise<{ok: true}> {
    if (!(input.left >= 0)) throw new ZentaoError(422, '记录工时必须提供完成后剩余工时(left)')
    const paths = [
      `index.php?m=task&f=recordWorkhour&taskID=${taskId}`,
      `index.php?m=task&f=recordEstimate&taskID=${taskId}`,
    ]
    let form: ParsedForm | undefined
    let lastErr: unknown
    for (const formPath of paths) {
      try {
        form = await this.fetchForm(formPath, 'consumed')
        break
      } catch (e) {
        if (e instanceof PasswordChangeRequiredError) throw e
        lastErr = e
      }
    }
    if (!form) {
      throw lastErr instanceof ZentaoError
        ? lastErr
        : new ZentaoError(404, `记工时入口不可用: ${String((lastErr as Error)?.message ?? lastErr)}`)
    }
    const date = input.date ?? new Date().toISOString().slice(0, 10)
    const res = await this.submitForm(
      form.action,
      {
        'date[]': date,
        'work[]': input.work ?? '',
        'consumed[]': String(input.consumed),
        'left[]': String(input.left),
      },
      form.action,
    )
    try {
      const data = JSON.parse(res.body) as {result?: string; message?: unknown}
      if (data.result === 'fail') {
        const msg = typeof data.message === 'string' ? data.message : JSON.stringify(data.message)
        throw new ZentaoError(422, `记工时被禅道拒绝：${msg}`)
      }
    } catch (e) {
      if (e instanceof ZentaoError) throw e
      /* 非 JSON 响应视为已提交，由调用方经 API 回读复核 */
    }
    return {ok: true}
  }

  /** 网页通道删除任务（REST DELETE 在 21.7.9 实例上不生效） */
  async deleteTask(taskId: number): Promise<void> {
    const res = await this.request(`index.php?m=task&f=delete&taskID=${taskId}&confirm=yes`)
    if (res.finalUrl.includes('changePassword')) {
      throw new PasswordChangeRequiredError()
    }
  }

  /** 通用网页 GET（供后续扩展读取禅道页面数据） */
  async getPage(path: string): Promise<BridgeResponse> {
    return this.request(path)
  }
}
