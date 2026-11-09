/** Agent 运行 API：发起 / 轮询 / 审批草案 / 回答决策 */
import type {FastifyInstance} from 'fastify'
import {randomUUID} from 'node:crypto'
import {defaultStore, executeAction, type DraftAction, type TandemStore} from '@tandem/core'
import {AgentRunner} from '@tandem/agent-runtime'
import {ZentaoAdapter, ZentaoSession} from '@tandem/adapter-zentao'
import {config, storeConfig} from '../config.js'
import type {Session} from '../sessions.js'

export async function agentRoutes(app: FastifyInstance) {
  const store: TandemStore = await defaultStore(storeConfig.file)
  const runner = new AgentRunner(store)
  const adapter = new ZentaoAdapter(config.ztBaseUrl)

  /** 用当前登录用户的凭证建立连接器会话（Agent 权限 = 挂靠人 = 当前用户） */
  function sessionOf(s: Session): ZentaoSession {
    return new ZentaoSession(s.account, s.client, s.bridge, s.bridgeOk, s.passwordChangeRequired ? '账号被要求先修改密码' : undefined)
  }

  app.get('/api/runs', async () => ({runs: store.listRuns()}))

  app.get('/api/runs/:id', async (req, reply) => {
    const run = store.getRun((req.params as {id: string}).id)
    if (!run) return reply.code(404).send({message: '运行不存在'})
    return run
  })

  /** 发起一次 Agent 运行 */
  app.post('/api/runs', async (req, reply) => {
    const {agentId, goal, maxSteps} = (req.body ?? {}) as {agentId?: number; goal?: string; maxSteps?: number}
    if (!agentId || !goal?.trim()) return reply.code(400).send({message: 'agentId 与 goal 必填'})
    const agent = store.getAgent(agentId)
    if (!agent) return reply.code(404).send({message: 'Agent 不存在'})
    if (!config.leadAccounts.has(req.session.account) && agent.ownerAccount !== req.session.account) {
      return reply.code(403).send({message: '只能运行挂靠在自己名下的 Agent'})
    }
    store.updateAgent(agent.id, {status: 'busy'})
    const r = runner.start({
      agent,
      goal: goal.trim(),
      adapter,
      session: sessionOf(req.session),
      store,
      maxSteps,
      onEvent: () => {},
    })
    return r
  })

  /** 人类回答决策后续跑 */
  app.post('/api/runs/:id/answer', async (req, reply) => {
    const {id} = req.params as {id: string}
    const run = store.getRun(id)
    if (!run) return reply.code(404).send({message: '运行不存在'})
    if (run.status !== 'waiting_approval') return reply.code(409).send({message: '该运行不在等待决策状态'})
    const {answer} = (req.body ?? {}) as {answer?: string}
    if (!answer?.trim()) return reply.code(400).send({message: 'answer 必填'})

    const decisionStep = run.stepsList.find((s) => s.kind === 'decision')
    const detail = (decisionStep?.detail ?? {}) as {
      history?: unknown
      pendingActions?: DraftAction[]
    }
    const agent = store.getAgent(run.agentId)
    if (!agent) return reply.code(404).send({message: 'Agent 已删除'})

    await runner.start({
      agent,
      goal: run.goal,
      adapter,
      session: sessionOf(req.session),
      store,
      maxSteps: run.maxSteps,
      resume: {
        runId: id,
        answer: answer.trim(),
        history: (detail.history ?? []) as never,
        pendingActions: detail.pendingActions ?? [],
      },
    })
    return {ok: true, resumed: true}
  })

  // ---------- 草案审批 ----------

  app.get('/api/drafts', async () => ({drafts: store.listPendingDrafts()}))

  app.get('/api/drafts/:id', async (req, reply) => {
    const d = store.getDraftRow((req.params as {id: string}).id)
    if (!d) return reply.code(404).send({message: '草案不存在'})
    return d
  })

  /** 批准并执行草案（人工确认入口） */
  app.post('/api/drafts/:id/execute', async (req, reply) => {
    const {id} = req.params as {id: string}
    const d = store.getDraftRow(id)
    if (!d) return reply.code(404).send({message: '草案不存在'})
    if (d.status !== 'pending') return reply.code(409).send({message: `草案状态为 ${d.status}`})
    const bad = (d.checks as Array<{ok: boolean}>).filter((c) => !c.ok)
    if (bad.length > 0) return reply.code(409).send({message: '草案存在未通过校验项，请先修正'})

    const sess = sessionOf(req.session)
    const results: Array<{index: number; ok: boolean; message: string}> = []
    for (let i = 0; i < d.actions.length; i++) {
      try {
        const msg = await executeAction(adapter, sess, d.actions[i] as DraftAction)
        results.push({index: i, ok: true, message: msg})
      } catch (e) {
        results.push({index: i, ok: false, message: e instanceof Error ? e.message : String(e)})
      }
    }
    store.setDraftStatus(id, 'executed', results)
    const okCount = results.filter((r) => r.ok).length
    if (d.runId) store.addRunStep(d.runId, 'executed', `人工批准草案，${okCount}/${results.length} 项执行成功`)
    return {summary: `${okCount}/${results.length} 项执行成功`, results}
  })

  app.post('/api/drafts/:id/discard', async (req, reply) => {
    const {id} = req.params as {id: string}
    const d = store.getDraftRow(id)
    if (!d) return reply.code(404).send({message: '草案不存在'})
    store.setDraftStatus(id, 'discarded')
    return {ok: true}
  })

  /** LLM 是否已配置（前端据此提示） */
  app.get('/api/agent/health', async () => ({
    llmConfigured: Boolean(process.env.TANDEM_LLM_BASE_URL && process.env.TANDEM_LLM_MODEL),
    model: process.env.TANDEM_LLM_MODEL ?? null,
    adapters: [{id: adapter.id, label: adapter.label}],
  }))
}

/** 供其它模块复用的草案 id 生成 */
export const newDraftId = () => randomUUID().slice(0, 8)
