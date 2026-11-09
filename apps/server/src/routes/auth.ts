import { PasswordChangeRequiredError, WebBridge, ZentaoClient } from '@tandem/adapter-zentao'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { createSession, destroySession, type Session } from '../sessions.js'

function sessionInfo(s: Session) {
  return {
    account: s.account,
    realname: s.realname,
    lead: config.leadAccounts.has(s.account),
    bridgeOk: s.bridgeOk,
    passwordChangeRequired: s.passwordChangeRequired,
    ztUrl: config.ztBaseUrl,
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/login', async (req, reply) => {
    const {account, password} = (req.body ?? {}) as {account?: string; password?: string}
    if (!account || !password) return reply.code(400).send({message: '请输入账号和密码'})

    const client = await ZentaoClient.login(config.ztBaseUrl, account, password)
    const bridge = new WebBridge(config.ztBaseUrl)
    let bridgeOk = false
    let passwordChangeRequired = false
    try {
      await bridge.login(account, password)
      bridgeOk = true
    } catch (e) {
      if (e instanceof PasswordChangeRequiredError) passwordChangeRequired = true
      // 其余网页桥接失败不阻塞登录：API 能力仍然可用
    }
    let realname = account
    try {
      realname = (await client.getUser(account)).realname || account
    } catch {
      /* 非致命 */
    }

    const s = createSession({account, password, realname, client, bridge, bridgeOk, passwordChangeRequired})
    reply.setCookie('ztp_sid', s.sid, {httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600})
    return sessionInfo(s)
  })

  app.post('/api/logout', async (req, reply) => {
    destroySession(req.cookies.ztp_sid)
    reply.clearCookie('ztp_sid', {path: '/'})
    return {ok: true}
  })

  app.get('/api/me', async (req) => sessionInfo(req.session))

  /** 重新检测网页桥接状态（如：用户已在禅道解除强制改密后，点按钮刷新横幅） */
  app.post('/api/refresh-bridge', async (req) => {
    const s = req.session
    try {
      await s.bridge.login(s.account, s.password)
      s.bridgeOk = true
      s.passwordChangeRequired = false
    } catch (e) {
      if (e instanceof PasswordChangeRequiredError) {
        s.bridgeOk = false
        s.passwordChangeRequired = true
      } else {
        s.bridgeOk = false
      }
    }
    return sessionInfo(s)
  })
}
