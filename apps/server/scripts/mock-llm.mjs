/**
 * 机制验证：本地 mock LLM（OpenAI 兼容），模拟 Agent 走完
 * 思考 → 只读工具 → propose 草案 → finish 的完整链路。
 * 运行：node mock-llm.mjs   然后设 TANDEM_LLM_BASE_URL=http://localhost:3400
 */
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const msgs = payload.messages ?? []
    const hasToolResult = msgs.some((m) => m.role === 'tool')
    const toolResultCount = msgs.filter((m) => m.role === 'tool').length

    let message
    if (toolResultCount === 0) {
      // 第一步：先看项目
      message = {
        role: 'assistant',
        content: '先查一下我可见的项目，确认目标项目与执行。',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_projects', arguments: '{}' } }],
      }
    } else if (toolResultCount === 1) {
      // 第二步：查执行
      const firstProjectId = (() => {
        try {
          const list = JSON.parse(msgs.filter((m) => m.role === 'tool').at(-1).content)
          return Array.isArray(list) && list[0] ? list[0].id : 18
        } catch {
          return 18
        }
      })()
      message = {
        role: 'assistant',
        content: `项目 ${firstProjectId} 已确认，查它的迭代。`,
        tool_calls: [
          { id: 'c2', type: 'function', function: { name: 'list_executions', arguments: JSON.stringify({ projectId: firstProjectId }) } },
        ],
      }
    } else if (toolResultCount === 2) {
      const execs = (() => {
        try {
          return JSON.parse(msgs.filter((m) => m.role === 'tool').at(-1).content)
        } catch {
          return []
        }
      })()
      const execId = Array.isArray(execs) && execs[0] ? execs[0].id : 87
      message = {
        role: 'assistant',
        content: '拆成 3 个任务并提交草案。',
        tool_calls: [
          {
            id: 'c3',
            type: 'function',
            function: {
              name: 'propose_tasks',
              arguments: JSON.stringify({
                tasks: [
                  { executionId: execId, name: '[Agent 草案] 登录页视觉稿评审', pri: 2, estimate: 2 },
                  { executionId: execId, name: '[Agent 草案] 登录页前端实现', pri: 2, estimate: 8 },
                  { executionId: execId, name: '[Agent 草案] 登录页联调与验收', pri: 3, estimate: 3 },
                ],
              }),
            },
          },
        ],
      }
    } else {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c4',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({ summary: '已拆解为 3 个任务并生成草案，等待你确认后落库。' }),
            },
          },
        ],
      }
    }
    void hasToolResult
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})

server.listen(3400, () => console.log('mock LLM on :3400'))
