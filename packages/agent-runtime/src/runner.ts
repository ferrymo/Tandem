/**
 * AgentRunner：目标循环器。
 *
 * 机制（与 docs/01 产品设计 v2 支柱二一致）：
 *   goal → [取上下文 → 思考 → 调工具 → 观察] × N
 *   写操作只能产出草案（永不直连落库）；需要人类决策时停下等答复；
 *   到达预算（步数上限/停止词）结束；全程逐步记录可追溯。
 */
import {randomUUID} from 'node:crypto'
import type {AdapterSession, AgentProfile, CollabAdapter, DraftAction, TandemStore} from '@tandem/core'
import {checkActions} from '@tandem/core'
import {chat, llmConfigFromEnv, type ChatMessage, type LlmConfig} from './llm.js'
import {callTool, toolSchemas, type ToolContext} from './tools.js'

export interface RunInput {
  agent: AgentProfile
  goal: string
  adapter: CollabAdapter
  session: AdapterSession
  store: TandemStore
  maxSteps?: number
  /** 由人在审批台回答后回填（续跑时） */
  resume?: {runId: string; answer: string; history: ChatMessage[]; pendingActions: DraftAction[]}
  llm?: Partial<LlmConfig>
  onEvent?: (e: {kind: string; title: string; detail?: unknown}) => void
}

export interface StartResult {
  runId: string
  status: string
  summary?: string
}

const ROLE_PROMPT: Record<string, string> = {
  planner: '你是规划者：把目标拆解为清晰、可执行、粒度适中的任务，标出优先级、预估工时与截止日期。',
  executor: '你是执行者：推进具体任务，必要时更新任务状态并记录工时。',
  tester: '你是测试：检查质量风险，把验证工作拆成可执行任务。',
  recorder: '你是记录员：整理工时与周报，把信息落成结构化任务备注。',
  watcher: '你是守望者：扫描异常（逾期、阻塞、负载失衡）并上报需要人类关注的点。',
  custom: '你是团队中的一个 AI 协作者。',
}

function systemPrompt(agent: AgentProfile, adapterLabel: string): string {
  return `${ROLE_PROMPT[agent.role] ?? ROLE_PROMPT.custom}

当前身份：${agent.name}（挂靠人权限：${agent.ownerAccount}），接入的协作系统：${adapterLabel}。
你的能力标签：${agent.capabilities.join('、') || '无'}；配备 skills：${agent.skills.join('、') || '无'}。

工作原则：
1. 先用只读工具了解现状（项目/执行/任务/负载），不要凭空假设 ID。
2. 一切写操作（建任务、改状态、记工时）必须调用 propose_* 工具——它只生成草案，由人类确认后才落库。绝不要声称"已创建/已完成"。
3. 遇到需要人类决定的问题（方案取舍、优先级冲突、资源不足），调用 ask_human 并停下。
4. 目标达成或无法继续时，调用 finish 给出结论与下一步建议。
5. 输出简洁、结构化；中文回答。`
}

export class AgentRunner {
  constructor(private readonly store: TandemStore) {}

  /** 启动一次运行（异步执行，调用方轮询状态） */
  start(input: RunInput): StartResult {
    const cfg = llmConfigFromEnv(input.llm)
    const runId = randomUUID().slice(0, 8)
    const maxSteps = Math.min(input.maxSteps ?? 8, 20)
    this.store.createRun({
      id: runId,
      agentId: input.agent.id,
      agentName: input.agent.name,
      ownerAccount: input.agent.ownerAccount,
      goal: input.goal,
      maxSteps,
    })
    void this.loop(runId, input, cfg, maxSteps).catch((e: unknown) => {
      this.store.updateRun(runId, {status: 'failed', error: e instanceof Error ? e.message : String(e)})
      this.event(input, runId, 'error', `运行异常：${e instanceof Error ? e.message : String(e)}`)
    })
    return {runId, status: 'running'}
  }

  private event(input: RunInput, runId: string, kind: string, title: string, detail?: unknown) {
    this.store.addRunStep(runId, kind, title, detail)
    input.onEvent?.({kind, title, detail})
  }

  private async loop(runId: string, input: RunInput, cfg: LlmConfig | null, maxSteps: number) {
    const {agent, goal, adapter, session} = input

    if (!cfg) {
      this.store.updateRun(runId, {status: 'failed', error: '未配置 LLM（TANDEM_LLM_BASE_URL / TANDEM_LLM_MODEL）'})
      this.event(input, runId, 'error', '未配置 LLM，无法运行 Agent')
      return
    }

    const ctx: ToolContext = {adapter, session, pendingActions: []}
    const messages: ChatMessage[] = input.resume?.history ?? [
      {role: 'system', content: systemPrompt(agent, adapter.label)},
      {role: 'user', content: `目标：${goal}`},
    ]
    if (input.resume) {
      // 人类答复续跑
      messages.push({role: 'user', content: `人类的答复：${input.resume.answer}`})
      ctx.pendingActions.push(...input.resume.pendingActions)
      this.event(input, runId, 'human', `人类答复：${input.resume.answer}`)
    }

    this.event(input, runId, 'start', `开始运行：${goal}`, {agent: agent.name, role: agent.role})

    for (let step = 0; step < maxSteps; step++) {
      this.store.updateRun(runId, {steps: step + 1})
      let reply
      try {
        reply = await chat(cfg, messages, toolSchemas())
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.store.updateRun(runId, {status: 'failed', error: msg})
        this.event(input, runId, 'error', `LLM 调用失败：${msg}`)
        return
      }

      if (reply.content) this.event(input, runId, 'thought', reply.content)
      messages.push({role: 'assistant', content: reply.content, toolCalls: reply.toolCalls})

      if (reply.toolCalls.length === 0) {
        this.store.updateRun(runId, {status: 'done', summary: reply.content ?? ''})
        await this.flushDrafts(runId, input, ctx)
        this.event(input, runId, 'done', '运行结束（模型未调用工具）')
        return
      }

      for (const call of reply.toolCalls) {
        this.event(input, runId, 'tool', `调用 ${call.name}`, call.arguments)
        const result = await callTool(call.name, call.arguments, ctx)
        messages.push({role: 'tool', toolCallId: call.id, content: result.content})
        this.event(input, runId, 'result', result.content.slice(0, 500))

        if (call.name === 'finish') {
          const summary = typeof call.arguments.summary === 'string' ? call.arguments.summary : ''
          this.store.updateRun(runId, {status: 'done', summary})
          await this.flushDrafts(runId, input, ctx)
          this.event(input, runId, 'done', '目标完成', {summary})
          return
        }

        if (result.decision) {
          // 停下来等人：把未决动作和上下文存进 run 的 detail，供续跑
          this.store.updateRun(runId, {status: 'waiting_approval', summary: result.decision.question})
          await this.flushDrafts(runId, input, ctx)
          this.event(input, runId, 'decision', result.decision.question, {
            options: result.decision.options,
            history: messages,
            pendingActions: ctx.pendingActions,
          })
          return
        }
      }
    }

    this.store.updateRun(runId, {status: 'stopped', summary: `达到步数上限（${maxSteps}）自动停止`})
    await this.flushDrafts(runId, input, ctx)
    this.event(input, runId, 'stop', `达到步数上限（${maxSteps}），已停止`)
  }

  /** 把本次运行累积的写动作落成一条草案（人审批的对象） */
  private async flushDrafts(runId: string, input: RunInput, ctx: ToolContext) {
    if (ctx.pendingActions.length === 0) return
    const draftId = randomUUID().slice(0, 8)
    const checks = await checkActions(input.adapter, input.session, ctx.pendingActions)
    this.store.saveDraft({
      id: draftId,
      source: 'agent',
      actor: input.agent.name,
      runId,
      actions: ctx.pendingActions,
      checks,
    })
    this.event(input, runId, 'draft', `生成草案 ${draftId}（${ctx.pendingActions.length} 项待确认）`, {draftId})
    ctx.pendingActions.length = 0
  }
}
