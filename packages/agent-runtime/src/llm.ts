/**
 * LLM 客户端（OpenAI 兼容协议）——不绑厂商，任何兼容端点即可接入。
 * 环境变量：TANDEM_LLM_BASE_URL / TANDEM_LLM_API_KEY / TANDEM_LLM_MODEL
 */

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ChatMessage =
  | {role: 'system' | 'user'; content: string}
  | {role: 'assistant'; content: string | null; toolCalls?: ToolCall[]}
  | {role: 'tool'; toolCallId: string; content: string}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmReply {
  content: string | null
  toolCalls: ToolCall[]
}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export function llmConfigFromEnv(override?: Partial<LlmConfig>): LlmConfig | null {
  const baseUrl = override?.baseUrl ?? process.env.TANDEM_LLM_BASE_URL
  const apiKey = override?.apiKey ?? process.env.TANDEM_LLM_API_KEY
  const model = override?.model ?? process.env.TANDEM_LLM_MODEL
  if (!baseUrl || !model) return null
  return {baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey ?? '', model}
}

/** 单轮对话：把消息与可用工具交给模型，解析出文本或工具调用 */
export async function chat(cfg: LlmConfig, messages: ChatMessage[], tools: ToolSchema[], signal?: AbortSignal): Promise<LlmReply> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: {name: t.name, arguments: JSON.stringify(t.arguments)},
          })),
        }
      }
      if (m.role === 'tool') return {role: 'tool', tool_call_id: m.toolCallId, content: m.content}
      return {role: m.role, content: m.content}
    }),
    temperature: 0.2,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}})),
          tool_choice: 'auto',
        }
      : {}),
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(cfg.apiKey ? {Authorization: `Bearer ${cfg.apiKey}`} : {})},
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM 调用失败(${res.status})：${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{message?: {content?: string | null; tool_calls?: Array<{id: string; function: {name: string; arguments: string}}>}}>
  }
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error('LLM 返回为空')
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t, i) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(t.function.arguments || '{}') as Record<string, unknown>
    } catch {
      args = {}
    }
    return {id: t.id || `call_${i}`, name: t.function.name, arguments: args}
  })
  return {content: msg.content ?? null, toolCalls}
}
