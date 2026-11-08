import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import {existsSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {PasswordChangeRequiredError, ZentaoError} from '@ztp/zentao-sdk'
import {config} from './config.js'
import {destroyExpired, getSession, type Session} from './sessions.js'
import {authRoutes} from './routes/auth.js'
import {overviewRoutes} from './routes/overview.js'
import {taskRoutes} from './routes/tasks.js'
import {effortRoutes} from './routes/effort.js'

declare module 'fastify' {
  interface FastifyRequest {
    session: Session
  }
}

const app = Fastify({logger: false, bodyLimit: 2 * 1024 * 1024})
await app.register(cookie)

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return
  if (req.url === '/api/login') return
  const s = getSession(req.cookies.ztp_sid)
  if (!s) return reply.code(401).send({message: '未登录或会话已过期'})
  req.session = s
})

await app.register(authRoutes)
await app.register(overviewRoutes)
await app.register(taskRoutes)
await app.register(effortRoutes)

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof PasswordChangeRequiredError) {
    return reply.code(409).send({code: 'PASSWORD_CHANGE_REQUIRED', message: err.message})
  }
  if (err instanceof ZentaoError) {
    return reply.code(err.status === 401 ? 401 : 502).send({code: 'ZT_ERROR', message: err.message})
  }
  const status = (err as {statusCode?: number}).statusCode ?? 500
  if (status >= 500) console.error(err)
  reply.code(status).send({message: err.message})
})

// 生产模式：托管 web 构建产物
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {root: webDist})
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({message: 'not found'})
    return reply.sendFile('index.html')
  })
}

setInterval(destroyExpired, 10 * 60 * 1000).unref()

await app.listen({port: config.port, host: '0.0.0.0'})
console.log(`zentaopro server 已启动: http://localhost:${config.port}  (禅道: ${config.ztBaseUrl})`)
